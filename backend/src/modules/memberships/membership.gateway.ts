import {
  Inject,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Namespace, Socket } from "socket.io";
import { isUUID } from "class-validator";
import { randomUUID } from "node:crypto";
import type {
  GroupChatChannel,
  GroupChatDeleted,
  GroupChatMessage,
  MembershipChanged,
} from "@streamora/contracts";
import { AccessTokenService } from "../auth/access-token.service";
import { SessionStore } from "../auth/session-store.service";
import { GroupAccessService } from "./group-access.service";
import { PrismaService } from "../../database/prisma.service";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { MembershipMediaService } from "./membership-media.service";

const RESERVED_CHAT_CHANNELS = new Set([
  "trò-chuyện-chung",
  "hỏi-đáp",
  "thông-báo",
]);

@WebSocketGateway({ namespace: "/classroom", maxHttpBufferSize: 16384 })
export class MembershipGateway
  implements OnApplicationBootstrap, OnModuleDestroy
{
  @WebSocketServer() server!: Namespace;
  private timer?: ReturnType<typeof setInterval>;
  private mediaTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private mediaBusy = false;
  private stopping = false;
  private version = 0n;
  private lastWarning = 0;
  private readonly logger = new Logger(MembershipGateway.name);
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStore,
    private readonly access: GroupAccessService,
    private readonly prisma: PrismaService,
    private readonly media: MembershipMediaService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}

  afterInit(server: Namespace) {
    server.use(async (client, next) => {
      try {
        if (
          client.handshake.headers.origin &&
          client.handshake.headers.origin !== this.config.webOrigin
        )
          throw new Error();
        const auth = await this.identity(client);
        client.data.userId = auth.user.id;
        next();
      } catch {
        next(new Error("UNAUTHENTICATED"));
      }
    });
  }
  async handleConnection(client: Socket) {
    try {
      const identity = await this.identity(client);
      await client.join(`user:${identity.user.id}`);
    } catch {
      client.disconnect(true);
    }
  }
  async onApplicationBootstrap() {
    const last = await this.prisma.membershipChange.findFirst({
      orderBy: { version: "desc" },
    });
    this.version = last?.version ?? 0n;
    this.timer = setInterval(() => void this.flush(), 500);
    this.timer.unref();
    this.mediaTimer = setInterval(() => void this.flushMedia(), 1000);
    this.mediaTimer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.mediaTimer);
    while (this.busy || this.mediaBusy)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }

  private async identity(client: Socket) {
    const token = client.handshake.auth?.accessToken;
    if (typeof token !== "string") throw new Error("UNAUTHENTICATED");
    const claims = this.tokens.verify(token);
    return this.sessions.authenticate(claims.userId, claims.sessionId);
  }
  private async authorize(client: Socket, body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      !("groupId" in body) ||
      typeof body.groupId !== "string" ||
      !isUUID(body.groupId)
    )
      throw new Error("VALIDATION_ERROR");
    const auth = await this.identity(client);
    const permissions = await this.access.require(auth.user.id, body.groupId);
    return {
      groupId: body.groupId,
      userId: auth.user.id,
      fullName: auth.user.fullName,
      role: permissions.role,
    };
  }
  private channel(body: unknown) {
    if (!body || typeof body !== "object" || !("channel" in body))
      return "trò-chuyện-chung";
    if (typeof body.channel !== "string") throw new Error("VALIDATION_ERROR");
    const channel = body.channel.trim();
    if (!channel || channel.length > 100) throw new Error("VALIDATION_ERROR");
    return channel;
  }
  private chatMessage(row: {
    id: string;
    groupId: string;
    senderId: string;
    senderName: string;
    senderRole: string;
    channel: string;
    text: string;
    replyToId: string | null;
    createdAt: Date;
    editedAt: Date | null;
  }): GroupChatMessage {
    return {
      id: row.id,
      clientId: null,
      groupId: row.groupId,
      senderId: row.senderId,
      senderName: row.senderName,
      senderRole: row.senderRole as GroupChatMessage["senderRole"],
      channel: row.channel,
      text: row.text,
      replyToId: row.replyToId,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
    };
  }
  private chatChannel(row: {
    id: string;
    groupId: string;
    name: string;
    createdById: string;
    createdAt: Date;
  }): GroupChatChannel {
    return { ...row, createdAt: row.createdAt.toISOString() };
  }
  private channelName(body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      !("name" in body) ||
      typeof body.name !== "string"
    )
      throw new Error("VALIDATION_ERROR");
    const name = body.name
      .trim()
      .normalize("NFC")
      .toLocaleLowerCase("vi")
      .replace(/\s+/g, "-");
    if (
      !name ||
      name.length > 40 ||
      /[\u0000-\u001f\u007f/?#%\\]/u.test(name) ||
      RESERVED_CHAT_CHANNELS.has(name)
    )
      throw new Error("VALIDATION_ERROR");
    return name;
  }
  private chatFailure(code: string, message: string) {
    return { ok: false as const, error: { code, message } };
  }
  private failure() {
    return {
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Bạn không còn quyền truy cập nhóm.",
      },
    };
  }

  @SubscribeMessage("auth:refresh")
  async refreshAuth(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    try {
      if (
        !body ||
        typeof body !== "object" ||
        !("accessToken" in body) ||
        typeof body.accessToken !== "string"
      )
        throw new Error();
      const claims = this.tokens.verify(body.accessToken);
      const identity = await this.sessions.authenticate(
        claims.userId,
        claims.sessionId,
      );
      if (identity.user.id !== client.data.userId) throw new Error();
      client.handshake.auth.accessToken = body.accessToken;
      return { ok: true };
    } catch {
      client.disconnect(true);
      return this.failure();
    }
  }

  @SubscribeMessage("channel:join")
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    try {
      const { groupId } = await this.authorize(client, body);
      const channel = this.channel(body);
      await client.join(`group:${groupId}`);
      const [rows, channels] = await Promise.all([
        this.prisma.groupChatMessage.findMany({
          where: { groupId, channel, deletedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
        }),
        this.prisma.groupChatChannel.findMany({
          where: { groupId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      ]);
      return {
        ok: true,
        groupId,
        channel,
        messages: rows.reverse().map((row) => this.chatMessage(row)),
        channels: channels.map((row) => this.chatChannel(row)),
      };
    } catch {
      return this.failure();
    }
  }
  @SubscribeMessage("chat:channel.create")
  async createChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    try {
      const { groupId, userId } = await this.authorize(client, body);
      const name = this.channelName(body);
      if (!client.rooms.has(`group:${groupId}`)) return this.failure();
      const existing = await this.prisma.groupChatChannel.findUnique({
        where: { groupId_name: { groupId, name } },
        select: { id: true },
      });
      if (existing)
        return this.chatFailure("CHANNEL_EXISTS", "Tên kênh đã tồn tại.");
      const saved = await this.prisma.groupChatChannel.create({
        data: {
          id: randomUUID(),
          groupId,
          name,
          createdById: userId,
        },
      });
      const channel = this.chatChannel(saved);
      await this.broadcastGroup(groupId, "chat:channel.created", channel);
      return { ok: true, channel };
    } catch (error) {
      if (error instanceof Error && error.message === "VALIDATION_ERROR")
        return this.chatFailure("VALIDATION_ERROR", "Tên kênh không hợp lệ.");
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      )
        return this.chatFailure("CHANNEL_EXISTS", "Tên kênh đã tồn tại.");
      return this.failure();
    }
  }
  @SubscribeMessage("chat:send")
  async send(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    try {
      const { groupId, userId, fullName, role } = await this.authorize(
        client,
        body,
      );
      const channel = this.channel(body);
      if (
        !body ||
        typeof body !== "object" ||
        !("text" in body) ||
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.trim().length > 4000
      )
        return this.chatFailure("VALIDATION_ERROR", "Tin nhắn không hợp lệ.");
      if (!client.rooms.has(`group:${groupId}`)) return this.failure();
      const payload = body as Record<string, unknown>;
      let clientId: string | null = null;
      if (payload.clientId !== undefined && payload.clientId !== null) {
        if (typeof payload.clientId !== "string" || !isUUID(payload.clientId))
          return this.chatFailure(
            "VALIDATION_ERROR",
            "Mã tin nhắn không hợp lệ.",
          );
        clientId = payload.clientId;
      }
      let replyToId: string | null = null;
      if (payload.replyToId !== undefined && payload.replyToId !== null) {
        if (typeof payload.replyToId !== "string" || !isUUID(payload.replyToId))
          return this.chatFailure(
            "VALIDATION_ERROR",
            "Tin nhắn được trả lời không hợp lệ.",
          );
        const target = await this.prisma.groupChatMessage.findFirst({
          where: {
            id: payload.replyToId,
            groupId,
            channel,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!target)
          return this.chatFailure(
            "NOT_FOUND",
            "Tin nhắn được trả lời không còn tồn tại.",
          );
        replyToId = target.id;
      }
      const saved = await this.prisma.groupChatMessage.create({
        data: {
          id: randomUUID(),
          groupId,
          senderId: userId,
          senderName: fullName,
          senderRole: role,
          channel,
          text: body.text.trim(),
          replyToId,
        },
      });
      const message = { ...this.chatMessage(saved), clientId };
      // Authorize recipients on every delivery so a membership removal blocks
      // new messages immediately; reconnects recover durable history from DB.
      await this.broadcastGroup(groupId, "chat:message", message);
      return { ok: true, id: message.id };
    } catch {
      return this.failure();
    }
  }
  @SubscribeMessage("chat:edit")
  async edit(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    try {
      const { groupId, userId } = await this.authorize(client, body);
      const channel = this.channel(body);
      if (!body || typeof body !== "object")
        return this.chatFailure("VALIDATION_ERROR", "Yêu cầu không hợp lệ.");
      const payload = body as Record<string, unknown>;
      if (
        typeof payload.id !== "string" ||
        !isUUID(payload.id) ||
        typeof payload.text !== "string" ||
        !payload.text.trim() ||
        payload.text.trim().length > 4000
      )
        return this.chatFailure("VALIDATION_ERROR", "Tin nhắn không hợp lệ.");
      const existing = await this.prisma.groupChatMessage.findFirst({
        where: {
          id: payload.id,
          groupId,
          channel,
          senderId: userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!existing)
        return this.chatFailure(
          "FORBIDDEN",
          "Bạn chỉ có thể sửa tin nhắn của mình.",
        );
      const saved = await this.prisma.groupChatMessage.update({
        where: { id: existing.id },
        data: { text: payload.text.trim(), editedAt: new Date() },
      });
      const message = this.chatMessage(saved);
      await this.broadcastGroup(groupId, "chat:message.updated", message);
      return { ok: true, id: message.id };
    } catch {
      return this.failure();
    }
  }
  @SubscribeMessage("chat:delete")
  async delete(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    try {
      const { groupId, userId } = await this.authorize(client, body);
      const channel = this.channel(body);
      if (!body || typeof body !== "object")
        return this.chatFailure("VALIDATION_ERROR", "Yêu cầu không hợp lệ.");
      const payload = body as Record<string, unknown>;
      if (typeof payload.id !== "string" || !isUUID(payload.id))
        return this.chatFailure("VALIDATION_ERROR", "Tin nhắn không hợp lệ.");
      const existing = await this.prisma.groupChatMessage.findFirst({
        where: {
          id: payload.id,
          groupId,
          channel,
          senderId: userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!existing)
        return this.chatFailure(
          "FORBIDDEN",
          "Bạn chỉ có thể xóa tin nhắn của mình.",
        );
      await this.prisma.groupChatMessage.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
      const deleted: GroupChatDeleted = { id: existing.id, groupId, channel };
      await this.broadcastGroup(groupId, "chat:message.deleted", deleted);
      return { ok: true, id: existing.id };
    } catch {
      return this.failure();
    }
  }
  async broadcastGroup(groupId: string, event: string, payload: unknown) {
    for (const socket of this.server.sockets.values()) {
      if (!socket.rooms.has(`group:${groupId}`)) continue;
      try {
        const auth = await this.identity(socket);
        await this.access.require(auth.user.id, groupId);
        socket.emit(event, payload);
      } catch {
        await socket.leave(`group:${groupId}`);
      }
    }
  }

  async flush() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const events = await this.prisma.membershipChange.findMany({
        where: { version: { gt: this.version } },
        orderBy: { version: "asc" },
        take: 100,
      });
      for (const event of events) {
        const payload: MembershipChanged = {
          groupId: event.groupId,
          userId: event.userId,
          role: event.role === "OWNER" ? null : event.role,
          removed: event.removed,
          version: event.version.toString(),
        };
        for (const socket of this.server.sockets.values()) {
          if (!socket.rooms.has(`user:${event.userId}`)) continue;
          try {
            await this.access.require(event.userId, event.groupId);
          } catch {
            await socket.leave(`group:${event.groupId}`);
          }
          socket.emit("membership.changed", payload);
        }
        this.version = event.version;
      }
    } catch {
      this.warn();
    } finally {
      this.busy = false;
    }
  }
  async flushMedia() {
    if (this.mediaBusy || this.stopping) return;
    this.mediaBusy = true;
    try {
      // Persistent retry survives restarts. Synchronize current DB permissions,
      // so replaying an older event cannot restore an obsolete role.
      const pending = await this.prisma.membershipChange.findMany({
        where: { mediaSyncedAt: null, nextAttemptAt: { lte: new Date() } },
        orderBy: [{ nextAttemptAt: "asc" }, { version: "asc" }],
        take: 20,
      });
      for (const event of pending) {
        if (this.stopping) break;
        try {
          await this.media.synchronize(event.groupId, event.userId);
          await this.prisma.membershipChange.update({
            where: { version: event.version },
            data: { mediaSyncedAt: new Date() },
          });
        } catch {
          await this.prisma.membershipChange.update({
            where: { version: event.version },
            data: {
              attempts: { increment: 1 },
              nextAttemptAt: new Date(
                Date.now() +
                  Math.min(30000, 500 * 2 ** Math.min(event.attempts, 6)),
              ),
            },
          });
          this.warn();
        }
      }
    } catch {
      this.warn();
    } finally {
      this.mediaBusy = false;
    }
  }
  private warn() {
    if (Date.now() - this.lastWarning < 60000) return;
    this.lastWarning = Date.now();
    this.logger.warn(
      "Đồng bộ quyền đang chờ thử lại. Kiểm tra database và cấu hình LiveKit.",
    );
  }
}
