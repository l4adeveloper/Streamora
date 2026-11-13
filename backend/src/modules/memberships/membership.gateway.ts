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
import { ApiError } from "../../common/api-error";
import type { Prisma } from "../../generated/prisma/client";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";

import { ChatStore } from "./chat-store";

const RESERVED_CHAT_CHANNELS = new Set([
  "trò-chuyện-chung",
  "hỏi-đáp",
  "thông-báo",
]);
const GROUP_MEETING_EVENTS = [
  "meeting.created",
  "session.changed",
  "session.ended",
];

@WebSocketGateway({ namespace: "/classroom", maxHttpBufferSize: 16384 })
export class MembershipGateway
  implements OnApplicationBootstrap, OnModuleDestroy
{
  @WebSocketServer() server!: Namespace;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private version = 0n;
  private meetingVersion = 0n;
  private chatVersion = 0n;
  private nextChatCleanup = 0;
  private lastWarning = 0;
  private readonly sendWindows = new Map<
    string,
    { start: number; count: number }
  >();
  private readonly seenChatEvents = new Map<string, number>();
  private chatSince = new Date(Date.now() - 60000).toISOString();
  private readonly logger = new Logger(MembershipGateway.name);
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStore,
    private readonly access: GroupAccessService,
    private readonly prisma: PrismaService,
    private readonly chat: ChatStore,
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
        client.data.authSessionId = auth.sessionId;
        next();
      } catch {
        next(new Error("UNAUTHENTICATED"));
      }
    });
  }
  async onApplicationBootstrap() {
    const [last, lastChat, lastMeeting] = await Promise.all([
      this.prisma.membershipChange.findFirst({ orderBy: { version: "desc" } }),
      this.prisma.groupChatChange.findFirst({ orderBy: { version: "desc" } }),
      this.prisma.classSessionChange.findFirst({
        where: { kind: { in: GROUP_MEETING_EVENTS } },
        orderBy: { version: "desc" },
      }),
    ]);
    this.version = last?.version ?? 0n;
    this.meetingVersion = lastMeeting?.version ?? 0n;
    this.chatVersion = lastChat?.version ?? 0n;
    this.timer = setInterval(() => void this.flush(), 500);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
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
    meetingId?: string | null;
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
      meetingId: row.meetingId ?? null,
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
        typeof body.accessToken !== "string" ||
        Object.keys(body).some((key) => key !== "accessToken")
      )
        throw new Error();
      const claims = this.tokens.verify(body.accessToken);
      const identity = await this.sessions.authenticate(
        claims.userId,
        claims.sessionId,
      );
      if (
        identity.user.id !== client.data.userId ||
        identity.sessionId !== client.data.authSessionId
      )
        throw new Error();
      client.handshake.auth.accessToken = body.accessToken;
      return { ok: true, data: {} };
    } catch {
      client.disconnect(false);
      return this.failure();
    }
  }

  @SubscribeMessage("channel:join")
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    try {
      const { groupId } = await this.authorize(client, body);
      const channel = this.channel(body);
      await this.chat.requireThread(groupId, channel);
      await client.join(`group:${groupId}`);
      if (!client.rooms.has(`group:${groupId}`))
        return this.chatFailure(
          "SERVICE_UNAVAILABLE",
          "Chưa thể tham gia cuộc trò chuyện.",
        );
      // Relational meeting commands own the announcement outbox; materialize before reading.
      if (channel === "thông-báo") {
        const announcements = await this.prisma.groupChatMessage.findMany({
          where: {
            groupId,
            channel,
            meetingId: { not: null },
            deletedAt: null,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
        });
        for (const row of announcements)
          if (!(await this.chat.get(groupId, row.id)))
            await this.chat.save(this.chatMessage(row));
      }
      const [page, channels] = await Promise.all([
        this.chat.history(groupId, channel),
        this.prisma.groupChatChannel.findMany({
          where: { groupId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      ]);
      return {
        ok: true,
        groupId,
        channel,
        messages: page.items,
        nextCursor: page.nextCursor,
        channels: channels.map((row) => this.chatChannel(row)),
      };
    } catch (error) {
      if (error instanceof ApiError)
        return {
          ok: false,
          ...(error.getResponse() as {
            error: { code: string; message: string };
          }),
        };
      return this.chatFailure(
        "SERVICE_UNAVAILABLE",
        "Dịch vụ trò chuyện tạm thời chưa sẵn sàng.",
      );
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
      const channel = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.groupChatChannel.create({
          data: { id: randomUUID(), groupId, name, createdById: userId },
        });
        const channel = this.chatChannel(saved);
        await this.recordChatChange(
          tx,
          groupId,
          "chat:channel.created",
          channel,
        );
        return channel;
      });
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
      const now = Date.now();
      for (const [id, value] of this.sendWindows)
        if (now - value.start > 10000) this.sendWindows.delete(id);
      const window = this.sendWindows.get(userId) ?? { start: now, count: 0 };
      if (++window.count > 20)
        return this.chatFailure(
          "RATE_LIMITED",
          "Bạn gửi quá nhanh. Vui lòng chờ một chút.",
        );
      this.sendWindows.set(userId, window);
      const channel = this.channel(body);
      await this.chat.requireThread(groupId, channel);
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
        const target = await this.chat.get(groupId, payload.replyToId);
        if (!target || target.channel !== channel)
          return this.chatFailure(
            "NOT_FOUND",
            "Tin nhắn được trả lời không còn tồn tại.",
          );
        replyToId = target.id;
      }
      const text = body.text.trim();
      if (channel === "hỏi-đáp")
        return this.chatFailure(
          "VALIDATION_ERROR",
          "Hãy tạo hoặc chọn một chủ đề hỏi đáp.",
        );
      const message = await this.chat.save({
        id: randomUUID(),
        clientId,
        groupId,
        senderId: userId,
        senderName: fullName,
        senderRole: role,
        channel,
        text,
        replyToId,
        meetingId: null,
        createdAt: new Date().toISOString(),
        editedAt: null,
      });
      return { ok: true, id: message.id };
    } catch (error) {
      if (error instanceof ApiError)
        return {
          ok: false,
          ...(error.getResponse() as {
            error: { code: string; message: string };
          }),
        };
      return this.chatFailure(
        "SERVICE_UNAVAILABLE",
        "Dịch vụ trò chuyện tạm thời chưa sẵn sàng.",
      );
    }
  }
  @SubscribeMessage("chat:edit")
  async edit(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    try {
      const { groupId, userId } = await this.authorize(client, body);
      const channel = this.channel(body);
      await this.chat.requireThread(groupId, channel);
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
      const existing = await this.chat.get(groupId, payload.id);
      if (
        !existing ||
        existing.senderId !== userId ||
        existing.channel !== channel ||
        existing.meetingId
      )
        return this.chatFailure(
          "FORBIDDEN",
          "Bạn chỉ có thể sửa tin nhắn của mình.",
        );
      const text = payload.text.trim();
      await this.chat.change(existing, text);
      return { ok: true, id: existing.id };
    } catch (error) {
      if (error instanceof ApiError)
        return {
          ok: false,
          ...(error.getResponse() as {
            error: { code: string; message: string };
          }),
        };
      return this.chatFailure(
        "SERVICE_UNAVAILABLE",
        "Dịch vụ trò chuyện tạm thời chưa sẵn sàng.",
      );
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
      await this.chat.requireThread(groupId, channel);
      if (!body || typeof body !== "object")
        return this.chatFailure("VALIDATION_ERROR", "Yêu cầu không hợp lệ.");
      const payload = body as Record<string, unknown>;
      if (typeof payload.id !== "string" || !isUUID(payload.id))
        return this.chatFailure("VALIDATION_ERROR", "Tin nhắn không hợp lệ.");
      const existing = await this.chat.get(groupId, payload.id);
      if (
        !existing ||
        existing.senderId !== userId ||
        existing.channel !== channel ||
        existing.meetingId
      )
        return this.chatFailure(
          "FORBIDDEN",
          "Bạn chỉ có thể xóa tin nhắn của mình.",
        );
      await this.chat.change(existing);
      return { ok: true, id: existing.id };
    } catch (error) {
      if (error instanceof ApiError)
        return {
          ok: false,
          ...(error.getResponse() as {
            error: { code: string; message: string };
          }),
        };
      return this.chatFailure(
        "SERVICE_UNAVAILABLE",
        "Dịch vụ trò chuyện tạm thời chưa sẵn sàng.",
      );
    }
  }
  private async recordChatChange(
    tx: Prisma.TransactionClient,
    groupId: string,
    event: string,
    payload: GroupChatMessage | GroupChatChannel | GroupChatDeleted,
  ) {
    // Allocate versions in commit order so a poll cannot skip a late commit.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(73021)::text`;
    await tx.groupChatChange.create({
      data: { groupId, event, payload: { ...payload } },
    });
  }

  private async broadcastGroup(
    groupId: string,
    event: string,
    payload: unknown,
  ) {
    const recipients: string[] = [];
    for (const socket of this.server.sockets.values()) {
      if (!socket.rooms.has(`group:${groupId}`)) continue;
      try {
        const auth = await this.identity(socket);
        await this.access.require(auth.user.id, groupId);
        recipients.push(socket.id);
      } catch (error) {
        // A revoked or unauthenticated socket must never receive chat content.
        if (!(error instanceof ApiError)) throw error;
      }
    }
    if (recipients.length) this.server.to(recipients).emit(event, payload);
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
          if (socket.data.userId !== event.userId) continue;
          let disconnect = false;
          try {
            await this.access.require(event.userId, event.groupId);
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            disconnect = socket.rooms.has(`group:${event.groupId}`);
          }
          socket.emit("membership.changed", payload);
          if (disconnect) socket.disconnect(false);
        }
        this.version = event.version;
      }
      const meetings = await this.prisma.classSessionChange.findMany({
        where: {
          kind: { in: GROUP_MEETING_EVENTS },
          version: { gt: this.meetingVersion },
        },
        orderBy: { version: "asc" },
        take: 100,
        include: { session: { include: { announcement: true } } },
      });
      for (const event of meetings) {
        const message = event.session.announcement;
        if (message && event.kind === "meeting.created") {
          if (!(await this.chat.get(message.groupId, message.id)))
            await this.chat.save(this.chatMessage(message));
          await this.broadcastGroup(
            message.groupId,
            "chat:message",
            this.chatMessage(message),
          );
          await this.broadcastGroup(message.groupId, "meeting.created", {
            groupId: message.groupId,
          });
        }
        if (event.session.groupId && event.kind !== "meeting.created") {
          await this.broadcastGroup(event.session.groupId, "meeting.updated", {
            groupId: event.session.groupId,
            sessionId: event.sessionId,
          });
        }
        this.meetingVersion = event.version;
      }
      const pollStart = Date.now();
      const groups = new Set<string>();
      for (const socket of this.server.sockets.values()) {
        for (const room of socket.rooms)
          if (room.startsWith("group:")) groups.add(room.slice(6));
      }
      for (const groupId of groups) {
        for (const event of await this.chat.events(groupId, this.chatSince)) {
          if (this.seenChatEvents.has(event.id)) continue;
          await this.broadcastGroup(groupId, event.event, event.payload);
          this.seenChatEvents.set(event.id, pollStart);
        }
      }
      this.chatSince = new Date(pollStart - 60000).toISOString();
      for (const [id, seenAt] of this.seenChatEvents)
        if (seenAt < pollStart - 120000) this.seenChatEvents.delete(id);
      const chat = await this.prisma.groupChatChange.findMany({
        where: { version: { gt: this.chatVersion } },
        orderBy: { version: "asc" },
        take: 100,
      });
      for (const change of chat) {
        await this.broadcastGroup(change.groupId, change.event, change.payload);
        this.chatVersion = change.version;
      }
      if (Date.now() >= this.nextChatCleanup) {
        await this.prisma.groupChatChange.deleteMany({
          where: { createdAt: { lt: new Date(Date.now() - 86400000) } },
        });
        this.nextChatCleanup = Date.now() + 3600000;
      }
    } catch {
      this.warn();
    } finally {
      this.busy = false;
    }
  }
  private warn() {
    if (Date.now() - this.lastWarning < 60000) return;
    this.lastWarning = Date.now();
    this.logger.warn(
      "Đồng bộ quyền và trò chuyện đang chờ thử lại. Kiểm tra kết nối database.",
    );
  }
}
