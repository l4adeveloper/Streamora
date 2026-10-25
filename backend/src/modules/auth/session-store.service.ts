import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError } from "../../common/api-error";
import { PUBLIC_USER_SELECT } from "../users/user.types";
import { revokeDisabledClassAccess } from "../../database/class-admission-revocation";

export type AuthTransaction = Prisma.TransactionClient;

@Injectable()
export class SessionStore {
  constructor(private readonly prisma: PrismaService) {}

  withUserLock<T>(userId: string, work: (tx: AuthTransaction) => Promise<T>) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        return work(tx);
      },
      { maxWait: 5000, timeout: 10000 },
    );
  }

  async now(tx: AuthTransaction) {
    const [clock] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    return clock.now;
  }

  async revokeDisabledUser(tx: AuthTransaction, userId: string, now: Date) {
    const result = await tx.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: {
        revokedAt: now,
        revocationReason: "USER_DISABLED",
        refreshRecoveryToken: null,
        refreshRecoveryUntil: null,
      },
    });
    await revokeDisabledClassAccess(tx, userId, now);
    return result;
  }

  async authenticate(userId: string, sessionId: string) {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      include: {
        user: { select: { ...PUBLIC_USER_SELECT, disabledAt: true } },
      },
    });
    if (!session || session.userId !== userId)
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Phiên đăng nhập không hợp lệ.",
      );
    if (session.user.disabledAt) {
      await this.withUserLock(userId, async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { disabledAt: true },
        });
        if (user?.disabledAt)
          await this.revokeDisabledUser(tx, userId, await this.now(tx));
      });
      throw new ApiError(403, "USER_DISABLED", "Tài khoản đã bị khóa.");
    }
    if (session.revokedAt || session.expiresAt.getTime() <= Date.now())
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Phiên đăng nhập đã kết thúc.",
      );
    const { disabledAt: _disabledAt, ...user } = session.user;
    return { user, sessionId };
  }
}
