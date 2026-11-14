import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
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
  MeetingChatMessage,
  MeetingChatDeleted,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import { AccessTokenService } from "../auth/access-token.service";
import { SessionStore } from "../auth/session-store.service";
import { ClassAdmissionsService } from "./class-admissions.service";
import {
  ClassPresenceService,
  type ClassConnection,
} from "./class-presence.service";
import { ClassSessionAutoCloseService } from "./class-session-auto-close.service";

interface Watch {
  participationId?: string;
  since?: bigint;
}
interface ClientState {
  connection: ClassConnection;
  watches: Map<string, Watch>;
  tail: Promise<unknown>;
  closing: boolean;
}

@WebSocketGateway({ namespace: "/classroom", maxHttpBufferSize: 16384 })
export class ClassSessionsGateway
  implements OnApplicationBootstrap, OnModuleDestroy {
  @WebSocketServer() server!: Namespace;
  private readonly instanceId = randomUUID();
  private readonly clients = new Map<string, ClientState>();
  private readonly meetingMessages = new Map<string, MeetingChatMessage[]>();
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
    @Optional() private readonly autoClose?: ClassSessionAutoCloseService,
  ) {}

  handleConnection(socket: Socket) {
    // MembershipGateway authenticates the shared namespace before connection.
    this.clients.set(socket.id, {
      connection: {
        userId: socket.data.userId,
        authSessionId: socket.data.authSessionId,
        instanceId: this.instanceId,
        socketId: socket.id,
      },
      watches: new Map(),
      tail: Promise.resolve(),
      closing: false,
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
    state.tail = result.catch(() => { });
    return result;
  }
  private action<T>(
    socket: Socket,
    work: (state: ClientState) => Promise<T>,
  ): Promise<ClassRealtimeAck<T>> {
    const state = this.clients.get(socket.id);
    if (!state || state.closing || this.stopping)
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
        this.logger.error("Websocket action error:", error);
        this.warn();
        return {
          ok: false as const,
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: `Chưa thể đồng bộ kết nối${error instanceof Error ? ` (${error.message})` : ""}; vui lòng thử lại.`,
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
        const watch = state.watches.get(sessionId);
        if (watch) watch.since ??= version;
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
  // ─── Meeting Chat (Ephemeral in-memory, no DB migration needed) ─────────

  private chatFailure(code: string, message: string): never {
    const status =
      code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : 400;
    throw new ApiError(status, code, message);
  }

  private async checkMeetingAccess(userId: string, sessionId: string) {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        kind: true,
        groupId: true,
        createdById: true,
        allowGuests: true,
      },
    });
    if (
      !session ||
      session.status === "ENDED" ||
      session.status === "CANCELLED"
    ) {
      this.chatFailure("FORBIDDEN", "Cuộc họp đã kết thúc.");
    }

    const ban = await this.prisma.sessionBan.findFirst({
      where: { sessionId, userId, revokedAt: null },
    });
    if (ban) {
      throw new ApiError(403, "BANNED", "Bạn đã bị chặn khỏi cuộc họp này.");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, globalRole: true, fullName: true },
    });
    if (!user) {
      this.chatFailure("UNAUTHENTICATED", "Không tìm thấy người dùng.");
    }

    let canManage =
      user.globalRole === "ADMIN" || session.createdById === userId;

    if (session.kind === "GROUP" && session.groupId) {
      const member = await this.prisma.groupMember.findUnique({
        where: { userId_groupId: { userId, groupId: session.groupId } },
      });
      if (member) {
        if (member.role === "OWNER" || member.role === "HOST") {
          canManage = true;
        }
      } else if (!canManage && !session.allowGuests) {
        const hasAccess =
          (await this.prisma.classParticipation.findFirst({
            where: { sessionId, userId },
            select: { id: true },
          })) ||
          (await this.prisma.classJoinRequest.findFirst({
            where: { sessionId, userId, status: "ACCEPTED" },
            select: { id: true },
          }));
        if (!hasAccess) {
          this.chatFailure(
            "FORBIDDEN",
            "Bạn chưa có quyền tham gia cuộc họp này.",
          );
        }
      }
    }

    const senderRole: "ADMIN" | "HOST" | "VIEWER" =
      user.globalRole === "ADMIN"
        ? "ADMIN"
        : canManage
          ? "HOST"
          : "VIEWER";

    return { session, user, canManage, senderRole };
  }

  @SubscribeMessage("meeting-chat:join")
  joinMeetingChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() value: unknown,
  ) {
    return this.action(socket, async (state) => {
      const body = value as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.sessionId !== "string" ||
        !isUUID(body.sessionId)
      )
        return this.chatFailure("VALIDATION_ERROR", "sessionId không hợp lệ.");
      const { sessionId } = body as { sessionId: string };
      await this.identity(socket, state);
      if (!state.watches.has(sessionId)) {
        state.watches.set(sessionId, {});
      }

      // Check access permission without blocking transactions
      await this.checkMeetingAccess(state.connection.userId, sessionId);

      // Leave any other meeting chat rooms on this socket to prevent cross-meeting message leakage
      for (const room of socket.rooms) {
        if (room.startsWith("meeting-chat:") && room !== `meeting-chat:${sessionId}`) {
          void socket.leave(room);
        }
      }

      await socket.join(`meeting-chat:${sessionId}`);
      const messages = (this.meetingMessages.get(sessionId) ?? []).slice(-200);
      return {
        ok: true as const,
        sessionId,
        messages,
      };
    });
  }

  @SubscribeMessage("meeting-chat:leave")
  leaveMeetingChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() value: unknown,
  ) {
    const body = value as Record<string, unknown> | null;
    if (body && typeof body.sessionId === "string") {
      void socket.leave(`meeting-chat:${body.sessionId}`);
    }
    return { ok: true as const };
  }

  @SubscribeMessage("meeting-chat:send")
  sendMeetingChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() value: unknown,
  ) {
    return this.action(socket, async (state) => {
      const body = value as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.sessionId !== "string" ||
        !isUUID(body.sessionId) ||
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.trim().length > 4000
      )
        return this.chatFailure(
          "VALIDATION_ERROR",
          "Dữ liệu tin nhắn không hợp lệ.",
        );
      const { sessionId } = body as { sessionId: string };
      await this.identity(socket, state);
      if (!state.watches.has(sessionId)) {
        state.watches.set(sessionId, {});
      }

      // Check meeting access and manager rights
      const { user, senderRole, canManage } = await this.checkMeetingAccess(
        state.connection.userId,
        sessionId,
      );

      // Only users connected to the meeting room (active participants) or managers can chat
      if (!canManage) {
        const activeParticipation =
          await this.prisma.classParticipation.findFirst({
            where: {
              sessionId,
              userId: state.connection.userId,
              leftAt: null,
            },
            select: { id: true },
          });
        if (!activeParticipation) {
          return this.chatFailure(
            "FORBIDDEN",
            "Bạn cần kết nối vào phòng họp để tham gia chat.",
          );
        }
      }

      let clientId: string | null = null;
      if (body.clientId !== undefined && body.clientId !== null) {
        if (typeof body.clientId !== "string" || !isUUID(body.clientId))
          return this.chatFailure("VALIDATION_ERROR", "clientId không hợp lệ.");
        clientId = body.clientId;
      }
      let replyToId: string | null = null;
      if (body.replyToId !== undefined && body.replyToId !== null) {
        if (typeof body.replyToId !== "string" || !isUUID(body.replyToId))
          return this.chatFailure("VALIDATION_ERROR", "replyToId không hợp lệ.");
        const currentList = this.meetingMessages.get(sessionId) ?? [];
        const target = currentList.find((m) => m.id === body.replyToId);
        if (!target)
          return this.chatFailure(
            "NOT_FOUND",
            "Tin nhắn được trả lời không còn tồn tại.",
          );
        replyToId = target.id;
      }
      const message: MeetingChatMessage = {
        id: randomUUID(),
        clientId,
        sessionId,
        senderId: state.connection.userId,
        senderName: user.fullName,
        senderRole,
        text: body.text.trim(),
        replyToId,
        createdAt: new Date().toISOString(),
      };
      let list = this.meetingMessages.get(sessionId);
      if (!list) {
        list = [];
        this.meetingMessages.set(sessionId, list);
      }
      list.push(message);
      if (list.length > 500) list.shift();

      this.server
        .to(`meeting-chat:${sessionId}`)
        .emit("meeting-chat:message", message);
      return { ok: true as const, id: message.id };
    });
  }

  @SubscribeMessage("meeting-chat:delete")
  deleteMeetingChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() value: unknown,
  ) {
    return this.action(socket, async (state) => {
      const body = value as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.sessionId !== "string" ||
        !isUUID(body.sessionId) ||
        typeof body.id !== "string" ||
        !isUUID(body.id)
      )
        return this.chatFailure("VALIDATION_ERROR", "Dữ liệu không hợp lệ.");
      const { sessionId, id } = body as { sessionId: string; id: string };
      await this.identity(socket, state);
      if (!state.watches.has(sessionId)) {
        state.watches.set(sessionId, {});
      }
      const { canManage } = await this.checkMeetingAccess(
        state.connection.userId,
        sessionId,
      );
      const list = this.meetingMessages.get(sessionId) ?? [];
      const index = list.findIndex((m) => m.id === id);
      if (index === -1)
        return this.chatFailure("NOT_FOUND", "Tin nhắn không tồn tại.");
      const existing = list[index];
      if (
        !canManage &&
        existing.senderId !== state.connection.userId
      ) {
        return this.chatFailure(
          "FORBIDDEN",
          "Bạn chỉ có thể xóa tin nhắn của mình.",
        );
      }
      list.splice(index, 1);
      const deleted: MeetingChatDeleted = { id, sessionId };
      this.server
        .to(`meeting-chat:${sessionId}`)
        .emit("meeting-chat:message.deleted", deleted);
      return { ok: true as const, id };
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
      const response = error.getResponse() as { error?: { code?: string } };
      socket.emit("session.access-revoked", {
        sessionId,
        ...(response.error?.code === "BANNED" ? { reason: "BANNED" } : {}),
      });
      await this.dropWatch(state, sessionId);
      socket.disconnect(false);
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
      for (const event of changes) {
        if (event.kind === "session.ended" || event.kind === "session.cancelled") {
          this.meetingMessages.delete(event.sessionId);
        }
      }
      for (const socket of this.server.sockets.values()) {
        const state = this.clients.get(socket.id);
        if (!state || state.closing || !state.watches.size) continue;
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
            const since = state.watches.get(sessionId)?.since ?? this.version;
            if (
              changes.some(
                (event) =>
                  event.sessionId === sessionId &&
                  event.version > since &&
                  event.kind === "moderation.banned" &&
                  event.subjectUserId === state.connection.userId,
              )
            ) {
              socket.emit("session.access-revoked", {
                sessionId,
                reason: "BANNED",
              });
              socket.disconnect(false);
              return;
            }
            const admission = await this.reconcile(socket, state, sessionId);
            if (!admission) continue;
            for (const event of changes) {
              if (event.sessionId !== sessionId || event.kind === "moderation.banned")
                continue;
              if (event.kind === "poll.updated") {
                if (
                  event.version > since &&
                  admission.permissions.canViewPolls &&
                  event.payload &&
                  !state.closing
                )
                  socket.emit("poll.updated", event.payload);
                continue;
              }
              const isSubject = event.subjectUserId === state.connection.userId;
              if (
                (event.kind === "moderation.mute" && (!isSubject || event.version <= since)) ||
                (event.kind === "moderation.changed" && !isSubject && !admission.permissions.canManage)
              )
                continue;
              const allowed =
                event.kind === "queue.changed"
                  ? admission.permissions.canManage
                  : event.kind === "participants.changed"
                    ? admission.permissions.canViewParticipants
                    : ["admission.changed", "access.changed"].includes(
                      event.kind,
                    )
                      ? !event.subjectUserId || isSubject
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
      await this.autoClose?.sweep();
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
