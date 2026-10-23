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
import type { MembershipChanged } from "@streamora/contracts";
import { AccessTokenService } from "../auth/access-token.service";
import { SessionStore } from "../auth/session-store.service";
import { GroupAccessService } from "./group-access.service";
import { PrismaService } from "../../database/prisma.service";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { MembershipMediaService } from "./membership-media.service";

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
    await this.access.require(auth.user.id, body.groupId);
    return { groupId: body.groupId, userId: auth.user.id };
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
      await client.join(`group:${groupId}`);
      return { ok: true, groupId };
    } catch {
      return this.failure();
    }
  }
  @SubscribeMessage("chat:send")
  async send(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    try {
      const { groupId, userId } = await this.authorize(client, body);
      if (
        !body ||
        typeof body !== "object" ||
        !("text" in body) ||
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > 4000
      )
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Tin nhắn không hợp lệ.",
          },
        };
      if (!client.rooms.has(`group:${groupId}`)) return this.failure();
      const message = {
        id: randomUUID(),
        groupId,
        senderId: userId,
        text: body.text.trim(),
        createdAt: new Date().toISOString(),
        demo: true,
      };
      // Authorize recipients on every delivery: removal blocks new messages even
      // during the short outbox polling interval and across API instances.
      await this.broadcastGroup(groupId, "chat:message", message);
      return { ok: true, id: message.id };
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
