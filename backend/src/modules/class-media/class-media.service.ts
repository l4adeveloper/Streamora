import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  ClassMediaHeartbeatRequest,
  JoinClassMediaRequest,
  JoinClassMediaResponse,
} from "@streamora/contracts";
import type {
  ClassMediaConnection,
  Prisma,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import {
  ClassParticipantService,
  type ClassSessionActor,
} from "../class-sessions/class-participant.service";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { ApiError } from "../../common/api-error";
import { IvsService } from "./ivs.service";
import { openMediaToken, sealMediaToken } from "./media-token";

const unavailable = () =>
  new ApiError(
    503,
    "MEDIA_UNAVAILABLE",
    "Chưa thể kết nối phòng video. Vui lòng thử lại.",
  );
@Injectable()
export class ClassMediaService {
  constructor(
    private readonly db: PrismaService,
    private readonly participants: ClassParticipantService,
    readonly ivs: IvsService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}

  async requireNotBanned(
    tx: Prisma.TransactionClient,
    sessionId: string,
    userId: string,
  ) {
    if (
      await tx.sessionBan.findFirst({
        where: { sessionId, userId, revokedAt: null },
      })
    )
      throw new ApiError(403, "BANNED", "Bạn đã bị chặn khỏi buổi học này.");
  }
  async require(
    actor: ClassSessionActor,
    sessionId: string,
    participationId: string,
  ) {
    return this.participants.withParticipant(
      actor,
      sessionId,
      participationId,
      async (context, tx) => {
        await this.requireNotBanned(tx, sessionId, actor.userId);
        return context;
      },
    );
  }
  async room(sessionId: string) {
    const now = new Date();
    await this.db.classMediaRoom.upsert({
      where: { sessionId },
      create: { sessionId },
      update: {},
    });
    const current = await this.db.classMediaRoom.findUniqueOrThrow({
      where: { sessionId },
    });
    if (current.state === "READY" && current.stageArn) return current.stageArn;
    if (["CLOSED", "CLOSING"].includes(current.state))
      throw new ApiError(409, "SESSION_NOT_LIVE", "Phòng video đã đóng.");
    const claimed = await this.db.classMediaRoom.updateMany({
      where: {
        sessionId,
        state: "PROVISIONING",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseUntil: new Date(now.getTime() + 120000) },
    });
    if (!claimed.count)
      throw new ApiError(
        409,
        "MEDIA_STARTING",
        "Phòng video đang được chuẩn bị. Vui lòng thử lại.",
      );
    try {
      const stageArn = await this.ivs.ensureStage(sessionId);
      await this.db.classMediaRoom.update({
        where: { sessionId },
        data: { stageArn, state: "READY", leaseUntil: null },
      });
      return stageArn;
    } catch {
      // Leave the lease in place after an uncertain AWS result; the next owner
      // discovers the tagged Stage before creating another one.
      throw unavailable();
    }
  }
  private response(row: ClassMediaConnection): JoinClassMediaResponse {
    return {
      requestId: row.requestId,
      connectionId: row.id,
      participantToken: openMediaToken(
        row.tokenCiphertext!,
        this.config.auth.accessTokenSecret,
        row.id,
      ),
      participantId: row.participantId!,
      expiresAt: row.expiresAt!.toISOString(),
      expiresIn: Math.max(
        0,
        Math.floor((row.expiresAt!.getTime() - Date.now()) / 1000),
      ),
      capabilities: ["PUBLISH", "SUBSCRIBE"],
    };
  }
  async join(
    actor: ClassSessionActor,
    sessionId: string,
    dto: JoinClassMediaRequest,
  ): Promise<JoinClassMediaResponse> {
    this.ivs.available();
    await this.require(actor, sessionId, dto.participationId);
    const stageArn = await this.room(sessionId);
    const claim = await this.participants.withParticipant(
      actor,
      sessionId,
      dto.participationId,
      async (_context, tx) => {
        await this.requireNotBanned(tx, sessionId, actor.userId);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${dto.participationId + dto.clientId}, 73005))::text`;
        const current = await tx.classMediaConnection.findUnique({
          where: {
            participationId_clientId: {
              participationId: dto.participationId,
              clientId: dto.clientId,
            },
          },
        });
        const now = new Date();
        const seen = await tx.classMediaRequest.findUnique({
          where: { id: dto.requestId },
        });
        if (
          seen &&
          (!current ||
            seen.connectionId !== current.id ||
            current.requestId !== dto.requestId)
        )
          throw new ApiError(
            409,
            "STALE_MEDIA_REQUEST",
            "Yêu cầu kết nối cũ đã được thay thế.",
          );
        if (
          seen &&
          (current?.state === "REVOKED" ||
            (current?.state === "ACTIVE" &&
              current.expiresAt &&
              current.expiresAt <= now))
        )
          throw new ApiError(
            409,
            "MEDIA_REQUEST_EXPIRED",
            "Yêu cầu kết nối đã hết hiệu lực. Vui lòng thử lại bằng thao tác mới.",
          );
        if (
          current?.authSessionId !== undefined &&
          current.authSessionId !== actor.authSessionId
        )
          throw new ApiError(
            403,
            "FORBIDDEN",
            "Kết nối thuộc phiên đăng nhập khác.",
          );
        if (
          current?.state === "ACTIVE" &&
          current.requestId === dto.requestId &&
          current.expiresAt! > now &&
          current.tokenCiphertext
        )
          return { row: current, cached: true };
        if (current?.state === "REVOKING")
          throw new ApiError(
            409,
            "MEDIA_REVOKING",
            "Kết nối cũ đang được đóng. Vui lòng thử lại.",
          );
        if (
          current?.state === "ISSUING" &&
          current.leaseUntil &&
          current.leaseUntil > now
        )
          throw new ApiError(
            409,
            "MEDIA_STARTING",
            "Yêu cầu kết nối đang được xử lý. Vui lòng thử lại.",
          );
        const row = await tx.classMediaConnection.upsert({
          where: {
            participationId_clientId: {
              participationId: dto.participationId,
              clientId: dto.clientId,
            },
          },
          create: {
            id: randomUUID(),
            sessionId,
            participationId: dto.participationId,
            userId: actor.userId,
            authSessionId: actor.authSessionId,
            clientId: dto.clientId,
            requestId: dto.requestId,
            leaseUntil: new Date(now.getTime() + 30000),
          },
          update: {
            ...(current?.state === "REVOKED"
              ? { participantId: null, expiresAt: null, tokenCiphertext: null }
              : {}),
            requestId: dto.requestId,
            state: "ISSUING",
            leaseUntil: new Date(now.getTime() + 30000),
            lastSeenAt: now,
          },
        });
        if (!seen)
          await tx.classMediaRequest.create({
            data: { id: dto.requestId, connectionId: row.id },
          });
        return { row, cached: false };
      },
    );
    if (claim.cached) return this.response(claim.row);
    let issued: Awaited<ReturnType<IvsService["token"]>> | undefined;
    try {
      if (claim.row.participantId) {
        try {
          await this.ivs.disconnect(stageArn, claim.row.participantId);
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "name" in error &&
            error.name === "ResourceNotFoundException" &&
            claim.row.expiresAt &&
            claim.row.expiresAt < new Date()
          ))
            throw error;
        }
      }
      const user = await this.db.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { fullName: true },
      });
      issued = await this.ivs.token(stageArn, actor.userId, user.fullName);
      const value = issued;
      const row = await this.participants.withParticipant(
        actor,
        sessionId,
        dto.participationId,
        async (_context, tx) => {
          await this.requireNotBanned(tx, sessionId, actor.userId);
          const saved = await tx.classMediaConnection.updateMany({
            where: {
              id: claim.row.id,
              requestId: dto.requestId,
              state: "ISSUING",
            },
            data: {
              participantId: value.participantId,
              tokenCiphertext: sealMediaToken(
                value.token,
                this.config.auth.accessTokenSecret,
                claim.row.id,
              ),
              expiresAt: value.expiresAt,
              state: "ACTIVE",
              leaseUntil: null,
              connected: false,
              lastSeenAt: new Date(),
            },
          });
          if (!saved.count)
            throw new ApiError(
              409,
              "MEDIA_REVOKING",
              "Kết nối đã được thay thế.",
            );
          return tx.classMediaConnection.findUniqueOrThrow({
            where: { id: claim.row.id },
          });
        },
      );
      return this.response(row);
    } catch (error) {
      if (issued)
        await this.ivs
          .disconnect(stageArn, issued.participantId)
          .catch(() => {});
      await this.db.classMediaConnection.updateMany({
        where: { id: claim.row.id, requestId: dto.requestId, state: "ISSUING" },
        data: { state: "REVOKING", leaseUntil: null, tokenCiphertext: null },
      });
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }
  async heartbeat(
    actor: ClassSessionActor,
    sessionId: string,
    id: string,
    dto: ClassMediaHeartbeatRequest,
  ) {
    return this.participants.withParticipant(
      actor,
      sessionId,
      dto.participationId,
      async (_context, tx) => {
        await this.requireNotBanned(tx, sessionId, actor.userId);
        const saved = await tx.classMediaConnection.updateMany({
          where: {
            id,
            sessionId,
            participationId: dto.participationId,
            userId: actor.userId,
            authSessionId: actor.authSessionId,
            clientId: dto.clientId,
            state: "ACTIVE",
            requestId: dto.requestId,
          },
          data: {
            lastSeenAt: new Date(),
            micEnabled: dto.micEnabled,
            cameraEnabled: dto.cameraEnabled,
          },
        });
        // connected comes from IVS reconciliation, never from a client assertion.
        if (!saved.count)
          throw new ApiError(
            403,
            "MEDIA_REVOKED",
            "Kết nối video đã kết thúc.",
          );
        return { ok: true };
      },
    );
  }
  async leave(
    actor: ClassSessionActor,
    sessionId: string,
    id: string,
    requestId: string,
  ) {
    const connection = await this.db.classMediaConnection.findFirst({
      where: {
        id,
        sessionId,
        userId: actor.userId,
        authSessionId: actor.authSessionId,
      },
    });
    if (!connection)
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Kết nối không tồn tại.");
    if (connection.state !== "REVOKED" && connection.requestId === requestId)
      await this.db.classMediaConnection.updateMany({
        where: { id, requestId },
        data: { state: "REVOKING", tokenCiphertext: null, connected: false },
      });
    return { ok: true };
  }
  async revoke(connection: ClassMediaConnection, stageArn: string) {
    const row = await this.db.classMediaConnection.updateMany({
      where: {
        id: connection.id,
        requestId: connection.requestId,
        state: { not: "REVOKED" },
      },
      data: { state: "REVOKING", tokenCiphertext: null, connected: false },
    });
    if (!row.count) return;
    if (connection.participantId) {
      try {
        await this.ivs.disconnect(stageArn, connection.participantId);
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "ResourceNotFoundException" &&
          connection.expiresAt &&
          connection.expiresAt < new Date()
        ))
          throw error;
      }
    }
    await this.db.classMediaConnection.updateMany({
      where: {
        id: connection.id,
        requestId: connection.requestId,
        state: "REVOKING",
      },
      data: { state: "REVOKED", connected: false },
    });
  }
}
