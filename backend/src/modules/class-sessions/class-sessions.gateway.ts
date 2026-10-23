import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Inject,
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
  ClassRealtimeAck,
  ClassSessionWatchRequest,
  ClassPresenceRequest,
  ClassWatchSnapshot,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { AccessTokenService } from "../auth/access-token.service";
import { SessionStore } from "../auth/session-store.service";
import { ClassAdmissionsService } from "./class-admissions.service";
import {
  ClassPresenceService,
  type ClassConnection,
} from "./class-presence.service";

interface Watch {
  participationId?: string;
}
interface ClientState {
  connection: ClassConnection;
  watches: Map<string, Watch>;
  tail: Promise<unknown>;
  closing: boolean;
}

@WebSocketGateway({ namespace: "/sessions", maxHttpBufferSize: 16384 })
export class ClassSessionsGateway
  implements OnApplicationBootstrap, OnModuleDestroy
{
  @WebSocketServer() server!: Namespace;
  private readonly instanceId = randomUUID();
  private readonly clients = new Map<string, ClientState>();
  private readonly logger = new Logger(ClassSessionsGateway.name);
  private timer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private sweeping = false;
  private stopping = false;
  private version = 0n;
  private lastWarning = 0;

  constructor(
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStore,
    private readonly admissions: ClassAdmissionsService,
    private readonly presence: ClassPresenceService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}

  afterInit(server: Namespace) {
    server.use(async (socket, next) => {
      try {
        if (
          this.stopping ||
          (socket.handshake.headers.origin &&
            socket.handshake.headers.origin !== this.config.webOrigin)
        )
          throw new ApiError(401, "UNAUTHENTICATED", "Kết nối không hợp lệ.");
        const claims = this.claims(socket);
        await this.sessions.authenticate(claims.userId, claims.sessionId);
        this.clients.set(socket.id, {
          connection: {
            userId: claims.userId,
            authSessionId: claims.sessionId,
            instanceId: this.instanceId,
            socketId: socket.id,
          },
          watches: new Map(),
          tail: Promise.resolve(),
          closing: false,
        });
        next();
      } catch {
        next(new Error("UNAUTHENTICATED"));
      }
    });
  }

  async onApplicationBootstrap() {
    this.version =
      (
        await this.prisma.classSessionChange.findFirst({
          orderBy: { version: "desc" },
        })
      )?.version ?? 0n;
    this.timer = setInterval(
      () => void this.flush(),
      this.presence.policy.pollIntervalMs,
    );
    this.sweepTimer = setInterval(
      () => void this.sweep(),
      this.presence.policy.sweepIntervalMs,
    );
    this.timer.unref();
    this.sweepTimer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.sweepTimer);
    while (this.busy || this.sweeping)
      await new Promise((resolve) => setTimeout(resolve, 10));
    for (const socket of this.server?.sockets.values() ?? [])
      socket.disconnect(false);
    await Promise.all([...this.clients.values()].map((state) => state.tail));
  }

  private claims(socket: Socket) {
    const token = socket.handshake.auth?.accessToken;
    if (typeof token !== "string")
      throw new ApiError(401, "UNAUTHENTICATED", "Cần đăng nhập.");
    return this.tokens.verify(token);
  }
  private async identity(socket: Socket, state: ClientState) {
    const claims = this.claims(socket);
    if (
      claims.userId !== state.connection.userId ||
      claims.sessionId !== state.connection.authSessionId
    )
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Phiên đăng nhập đã thay đổi.",
      );
    await this.sessions.authenticate(claims.userId, claims.sessionId);
  }
  private enqueue<T>(state: ClientState, work: () => Promise<T>): Promise<T> {
    const result = state.tail.then(work);
    state.tail = result.catch(() => {});
    return result;
  }
  private action<T>(
    socket: Socket,
    work: (state: ClientState) => Promise<T>,
  ): Promise<ClassRealtimeAck<T>> {
    const state = this.clients.get(socket.id);
    if (!state || state.closing)
      return Promise.resolve({
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Kết nối đã đóng." },
      });
    return this.enqueue(state, async () => {
      try {
        if (state.closing)
          throw new ApiError(401, "UNAUTHENTICATED", "Kết nối đã đóng.");
        return { ok: true as const, data: await work(state) };
      } catch (error) {
        if (error instanceof ApiError) {
          if (
            error.getStatus() === 401 ||
            (error.getResponse() as { error: { code: string } }).error.code ===
              "USER_DISABLED"
          )
            socket.disconnect(false);
          return {
            ok: false as const,
            ...(error.getResponse() as {
              error: { code: string; message: string };
            }),
          };
        }
        this.warn();
        return {
          ok: false as const,
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Chưa thể đồng bộ kết nối; vui lòng thử lại.",
          },
        };
      }
    });
  }
  private body(value: unknown, presence = false): ClassPresenceRequest {
    const body = value as Record<string, unknown> | null;
    const keys = presence ? ["sessionId", "participationId"] : ["sessionId"];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !keys.includes(key)) ||
      keys.some(
        (key) =>
          typeof body[key] !== "string" || !isUUID(body[key] as string, "4"),
      )
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Dữ liệu kết nối không hợp lệ.",
      );
    return body as unknown as ClassPresenceRequest;
  }

  @SubscribeMessage("session:watch")
  watch(@ConnectedSocket() socket: Socket, @MessageBody() value: unknown) {
    return this.action(socket, async (state) => {
      const { sessionId }: ClassSessionWatchRequest = this.body(value);
      await this.identity(socket, state);
      if (
        !state.watches.has(sessionId) &&
        state.watches.size >= this.presence.policy.maxWatches
      )
        throw new ApiError(
          429,
          "WATCH_LIMIT",
          "Đã theo dõi quá nhiều buổi học.",
        );
      const existing = state.watches.get(sessionId);
      state.watches.set(sessionId, existing ?? {});
      try {
        // Register first, then read the high water mark before the snapshot. Events
        // committed during the snapshot queue behind this action on this socket.
        const version =
          (
            await this.prisma.classSessionChange.findFirst({
              orderBy: { version: "desc" },
            })
          )?.version ?? 0n;
        const admission = await this.admissions.state(
          state.connection.userId,
          sessionId,
        );
        const snapshot: ClassWatchSnapshot = {
          sessionId,
          admission,
          version: version.toString(),
          heartbeatIntervalMs: this.presence.policy.heartbeatIntervalMs,
          reconnectGraceMs: this.presence.policy.leaseTtlMs,
        };
        return snapshot;
      } catch (error) {
        if (!existing) state.watches.delete(sessionId);
        throw error;
      }
    });
  }
  @SubscribeMessage("session:unwatch")
  unwatch(@ConnectedSocket() socket: Socket, @MessageBody() value: unknown) {
    return this.action(socket, async (state) => {
      const { sessionId } = this.body(value);
      await this.identity(socket, state);
      await this.dropWatch(state, sessionId);
      return {};
    });
  }
  @SubscribeMessage("participation:attach")
  attach(@ConnectedSocket() socket: Socket, @MessageBody() value: unknown) {
    return this.renew(socket, value, true);
  }
  @SubscribeMessage("participation:heartbeat")
  heartbeat(@ConnectedSocket() socket: Socket, @MessageBody() value: unknown) {
    return this.renew(socket, value, false);
  }
  private renew(socket: Socket, value: unknown, attach: boolean) {
    return this.action(socket, async (state) => {
      const { sessionId, participationId } = this.body(value, true);
      await this.identity(socket, state);
      const watch = state.watches.get(sessionId);
      if (!watch || (!attach && watch.participationId !== participationId))
        throw new ApiError(
          403,
          "PRESENCE_NOT_ATTACHED",
          "Cần theo dõi buổi học và gắn kết nối trước.",
        );
      const receipt = await this.presence.renew(
        state.connection,
        sessionId,
        participationId,
        attach,
      );
      watch.participationId = participationId;
      // A disconnect during a DB request is serialized behind it, releasing its lease.
      return receipt;
    });
  }
  @SubscribeMessage("auth:refresh")
  refresh(@ConnectedSocket() socket: Socket, @MessageBody() value: unknown) {
    return this.action(socket, async (state) => {
      const body = value as { accessToken?: unknown } | null;
      if (
        !body ||
        typeof body.accessToken !== "string" ||
        Object.keys(body).some((key) => key !== "accessToken")
      )
        throw new ApiError(400, "VALIDATION_ERROR", "Token không hợp lệ.");
      const claims = this.tokens.verify(body.accessToken);
      if (
        claims.userId !== state.connection.userId ||
        claims.sessionId !== state.connection.authSessionId
      )
        throw new ApiError(
          401,
          "UNAUTHENTICATED",
          "Cần kết nối lại khi đổi phiên đăng nhập.",
        );
      await this.sessions.authenticate(claims.userId, claims.sessionId);
      socket.handshake.auth.accessToken = body.accessToken;
      return {};
    });
  }
  handleDisconnect(socket: Socket) {
    const state = this.clients.get(socket.id);
    if (!state) return;
    state.closing = true;
    void this.enqueue(state, async () => {
      try {
        for (const sessionId of [...state.watches.keys()])
          await this.dropWatch(state, sessionId);
      } catch {
        this.warn();
      } finally {
        // An unavailable DB still expires leases by their deadline.
        this.clients.delete(socket.id);
      }
    });
  }
  private async dropWatch(state: ClientState, sessionId: string) {
    const watch = state.watches.get(sessionId);
    try {
      if (watch?.participationId)
        await this.presence.detach(
          state.connection,
          sessionId,
          watch.participationId,
        );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    } finally {
      state.watches.delete(sessionId);
    }
  }
  private async reconcile(
    socket: Socket,
    state: ClientState,
    sessionId: string,
  ) {
    try {
      const admission = await this.admissions.state(
        state.connection.userId,
        sessionId,
      );
      const watch = state.watches.get(sessionId);
      if (watch?.participationId) {
        const bound = await this.prisma.classParticipation.findUnique({
          where: { id: watch.participationId },
          select: { leftAt: true, leaveReason: true },
        });
        if (bound?.leftAt) {
          socket.emit("participation.closed", {
            sessionId,
            participationId: watch.participationId,
            reason: bound.leaveReason,
          });
          delete watch.participationId;
        }
      }
      return admission;
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        ![403, 404].includes(error.getStatus())
      )
        throw error;
      socket.emit("session.access-revoked", { sessionId });
      await this.dropWatch(state, sessionId);
      return null;
    }
  }
  async flush() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const changes = await this.prisma.classSessionChange.findMany({
        where: { version: { gt: this.version } },
        orderBy: { version: "asc" },
        take: 100,
      });
      for (const socket of this.server.sockets.values()) {
        const state = this.clients.get(socket.id);
        if (!state || state.closing) continue;
        await this.enqueue(state, async () => {
          if (state.closing) return;
          try {
            await this.identity(socket, state);
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            socket.disconnect(false);
            return;
          }
          for (const sessionId of [...state.watches.keys()]) {
            const admission = await this.reconcile(socket, state, sessionId);
            if (!admission) continue;
            for (const event of changes) {
              if (event.sessionId !== sessionId) continue;
              const allowed =
                event.kind === "queue.changed"
                  ? admission.permissions.canManage
                  : event.kind === "participants.changed"
                    ? admission.permissions.canViewParticipants
                    : ["admission.changed", "access.changed"].includes(
                          event.kind,
                        )
                      ? !event.subjectUserId ||
                        event.subjectUserId === state.connection.userId
                      : true;
              if (allowed && !state.closing)
                socket.emit(event.kind, {
                  eventId: event.eventId,
                  sessionId,
                  version: event.version.toString(),
                });
            }
          }
        });
      }
      if (changes.length) this.version = changes.at(-1)!.version;
    } catch {
      this.warn();
    } finally {
      // Retry without advancing; clients deduplicate eventId.
      this.busy = false;
    }
  }
  async sweep() {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      await this.presence.sweep();
    } catch {
      this.warn();
    } finally {
      this.sweeping = false;
    }
  }
  private warn() {
    if (Date.now() - this.lastWarning < 60000) return;
    this.lastWarning = Date.now();
    this.logger.warn(
      "Đồng bộ buổi học đang chờ thử lại. Kiểm tra kết nối database.",
    );
  }
}
