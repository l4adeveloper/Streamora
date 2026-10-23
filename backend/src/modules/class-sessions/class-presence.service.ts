import { Inject, Injectable } from "@nestjs/common";
import {
  CLASS_REALTIME_POLICY,
  type ClassPresenceReceipt,
} from "@streamora/contracts";
import type {
  ClassParticipation,
  ClassSession,
  Prisma,
} from "../../generated/prisma/client";
import { ApiError } from "../../common/api-error";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import {
  classServerTime,
  classVisitCurrent,
  closeClassVisit,
  validClassLease,
} from "../../database/class-presence";
import { ClassSessionAccessService } from "./class-session-access.service";

type Tx = Prisma.TransactionClient;
export interface ClassConnection {
  userId: string;
  authSessionId: string;
  instanceId: string;
  socketId: string;
}

@Injectable()
export class ClassPresenceService {
  readonly policy;
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ClassSessionAccessService,
    @Inject(APP_CONFIG) config: EnvironmentConfig,
  ) {
    this.policy = { ...CLASS_REALTIME_POLICY, ...config.sessionRealtime };
  }

  private async withVisit<T>(
    userId: string,
    sessionId: string,
    participationId: string,
    work: (
      tx: Tx,
      row: ClassSession,
      visit: ClassParticipation,
      now: Date,
      manage: boolean,
    ) => Promise<T | ApiError>,
  ) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.access.lockUsers(tx, [userId]);
        const row = await this.access.load(tx, sessionId, "update");
        const visit = await tx.classParticipation.findFirst({
          where: { id: participationId, sessionId, userId },
        });
        if (!visit)
          throw new ApiError(
            404,
            "PARTICIPATION_NOT_FOUND",
            "Không tìm thấy lượt tham gia.",
          );
        const now = await classServerTime(tx);
        let manage = false;
        try {
          manage = await this.access.eligible(tx, userId, row);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await closeClassVisit(tx, visit, now, "ACCESS_REVOKED");
          return error;
        }
        return work(tx, row, visit, now, manage);
      },
      { timeout: 10000 },
    );
    if (result instanceof ApiError) throw result;
    return result as T;
  }

  async renew(
    connection: ClassConnection,
    sessionId: string,
    participationId: string,
    attach: boolean,
  ): Promise<ClassPresenceReceipt> {
    return this.withVisit(
      connection.userId,
      sessionId,
      participationId,
      async (tx, row, visit, now, manage) => {
        const auth = await tx.authSession.findFirst({
          where: {
            id: connection.authSessionId,
            userId: connection.userId,
            revokedAt: null,
            expiresAt: { gt: now },
          },
        });
        if (!auth)
          return new ApiError(
            401,
            "UNAUTHENTICATED",
            "Phiên đăng nhập đã kết thúc.",
          );
        const grant = visit.joinRequestId
          ? await tx.classJoinRequest.findUnique({
              where: { id: visit.joinRequestId },
            })
          : null;
        if (
          row.status !== "LIVE" ||
          visit.leftAt ||
          (grant && grant.status !== "ACCEPTED")
        ) {
          await closeClassVisit(
            tx,
            visit,
            now,
            row.status === "ENDED" ? "SESSION_ENDED" : "ACCESS_REVOKED",
          );
          return new ApiError(
            403,
            "ADMISSION_REVOKED",
            "Lượt tham gia không còn hiệu lực.",
          );
        }
        if (
          !(await classVisitCurrent(tx, visit, now, this.policy.leaseTtlMs))
        ) {
          await closeClassVisit(tx, visit, now, "DISCONNECTED");
          return new ApiError(
            403,
            "ADMISSION_REVOKED",
            "Kết nối đã hết hạn; cần xin vào lại.",
          );
        }
        const key = {
          instanceId: connection.instanceId,
          socketId: connection.socketId,
          participationId,
        };
        if (!attach) {
          const lease = await tx.classPresenceLease.findUnique({
            where: { instanceId_socketId_participationId: key },
          });
          if (
            !lease ||
            !lease.connected ||
            lease.authSessionId !== auth.id ||
            lease.expiresAt <= now
          )
            return new ApiError(
              403,
              "PRESENCE_NOT_ATTACHED",
              "Cần gắn kết nối vào lượt tham gia trước.",
            );
        }
        const expiresAt = new Date(now.getTime() + this.policy.leaseTtlMs);
        await tx.classPresenceLease.upsert({
          where: { instanceId_socketId_participationId: key },
          create: {
            ...key,
            authSessionId: auth.id,
            lastHeartbeatAt: now,
            expiresAt,
          },
          update: { connected: true, lastHeartbeatAt: now, expiresAt },
        });
        await tx.classParticipation.update({
          where: { id: participationId },
          data: { lastSeenAt: now },
        });
        return {
          participationId,
          serverTime: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };
      },
    );
  }

  async detach(
    connection: ClassConnection,
    sessionId: string,
    participationId: string,
  ) {
    await this.withVisit(
      connection.userId,
      sessionId,
      participationId,
      async (tx, _row, visit, now) => {
        if (visit.leftAt) return;
        const changed = await tx.classPresenceLease.updateMany({
          where: {
            instanceId: connection.instanceId,
            socketId: connection.socketId,
            participationId,
            connected: true,
            expiresAt: { gt: now },
          },
          data: {
            connected: false,
            lastHeartbeatAt: now,
            expiresAt: new Date(now.getTime() + this.policy.leaseTtlMs),
          },
        });
        // Repeated disconnect callbacks cannot keep extending the grace period.
        if (changed.count)
          await tx.classParticipation.update({
            where: { id: participationId },
            data: { lastSeenAt: now },
          });
      },
    );
  }

  async sweep() {
    const visits = await this.prisma.classParticipation.findMany({
      where: { leftAt: null },
      orderBy: [{ presenceCheckedAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    for (const candidate of visits) {
      try {
        await this.withVisit(
          candidate.userId,
          candidate.sessionId,
          candidate.id,
          async (tx, row, visit, now, manage) => {
            if (visit.leftAt) return;
            const grant = visit.joinRequestId
              ? await tx.classJoinRequest.findUnique({
                  where: { id: visit.joinRequestId },
                })
              : null;
            const invalid = await tx.classPresenceLease.deleteMany({
              where: {
                participationId: visit.id,
                OR: [
                  { authSession: { revokedAt: { not: null } } },
                  { authSession: { expiresAt: { lte: now } } },
                ],
              },
            });
            const valid = await tx.classPresenceLease.count({
              where: { participationId: visit.id, ...validClassLease(now) },
            });
            if (
              row.status !== "LIVE" ||
              (grant && grant.status !== "ACCEPTED") ||
              (invalid.count && !valid)
            )
              await closeClassVisit(
                tx,
                visit,
                now,
                row.status === "ENDED" ? "SESSION_ENDED" : "ACCESS_REVOKED",
              );
            else if (
              !(await classVisitCurrent(tx, visit, now, this.policy.leaseTtlMs))
            )
              await closeClassVisit(tx, visit, now, "DISCONNECTED");
            await tx.classPresenceLease.deleteMany({
              where: { participationId: visit.id, expiresAt: { lte: now } },
            });
            await tx.classParticipation.update({
              where: { id: visit.id },
              data: { presenceCheckedAt: now },
            });
          },
        );
      } catch (error) {
        // Revocation is committed by withVisit before it reports lost eligibility.
        if (!(error instanceof ApiError)) throw error;
      }
    }
  }
}
