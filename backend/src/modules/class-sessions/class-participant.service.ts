import { Injectable } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { ClassSessionParticipantContext } from "@streamora/contracts";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import { classServerTime } from "../../database/class-presence";
import { ClassSessionAccessService } from "./class-session-access.service";

export interface ClassSessionActor {
  userId: string;
  authSessionId: string;
}

@Injectable()
export class ClassParticipantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ClassSessionAccessService,
  ) {}

  require(
    actor: ClassSessionActor,
    sessionId: string,
    participationId: string,
    manage = false,
  ) {
    return this.withParticipant(
      actor,
      sessionId,
      participationId,
      async (context) => context,
      manage,
    );
  }

  /** Recheck and hold authorization through a local DB operation or local signing.
   * Actor must come from verified CurrentAuth; resource IDs are always resolved in DB.
   */
  withParticipant<T>(
    actor: ClassSessionActor,
    sessionId: string,
    participationId: string,
    work: (
      context: ClassSessionParticipantContext,
      tx: Prisma.TransactionClient,
    ) => Promise<T>,
    manage = false,
  ): Promise<T> {
    if (
      ![actor?.userId, actor?.authSessionId, sessionId, participationId].every(
        (id) => typeof id === "string" && isUUID(id, "4"),
      )
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Thông tin buổi học hoặc lượt tham gia không hợp lệ.",
      );
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.lockUsers(tx, [actor.userId]);
        await this.access.requireUser(tx, actor.userId);
        await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${actor.authSessionId}::uuid FOR SHARE`;
        const now = await classServerTime(tx);
        const auth = await tx.authSession.findFirst({
          where: {
            id: actor.authSessionId,
            userId: actor.userId,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true, expiresAt: true },
        });
        if (!auth)
          throw new ApiError(
            401,
            "UNAUTHENTICATED",
            "Phiên đăng nhập đã kết thúc.",
          );
        const row = await this.access.load(tx, sessionId, "share");
        const canManage = await this.access.eligible(tx, actor.userId, row);
        if (auth.expiresAt <= (await classServerTime(tx)))
          throw new ApiError(
            401,
            "UNAUTHENTICATED",
            "Phiên đăng nhập đã hết hạn.",
          );
        if (row.status !== "LIVE")
          throw new ApiError(
            409,
            "SESSION_NOT_LIVE",
            "Buổi học chưa mở hoặc đã kết thúc.",
          );
        if (manage && !canManage)
          throw new ApiError(
            403,
            "FORBIDDEN",
            "Bạn không có quyền quản lý buổi học này.",
          );
        const visit = await this.access.activeVisit(tx, actor.userId, row);
        if (!visit)
          throw new ApiError(
            403,
            "ADMISSION_REQUIRED",
            "Bạn cần thực sự vào phòng trước khi dùng chức năng này.",
          );
        if (visit.id !== participationId)
          throw new ApiError(
            403,
            "ADMISSION_REVOKED",
            "Lượt tham gia này không còn hiệu lực.",
          );
        return work(
          {
            session: {
              id: row.id,
              kind: row.kind,
              groupId: row.groupId,
              status: "LIVE",
            },
            userId: actor.userId,
            authSessionId: auth.id,
            participationId: visit.id,
            canManage,
            checkedAt: (await classServerTime(tx)).toISOString(),
          },
          tx,
        );
      },
      { timeout: 10000 },
    );
  }
}
