import { Inject, Injectable } from "@nestjs/common";
import { CLASS_REALTIME_POLICY } from "@streamora/contracts";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import {
  classServerTime,
  classVisitCurrent,
} from "../../database/class-presence";
import type { ClassSession, Prisma } from "../../generated/prisma/client";
import { ApiError } from "../../common/api-error";
import { GroupAccessService } from "../memberships/group-access.service";

type Tx = Prisma.TransactionClient;

@Injectable()
export class ClassSessionAccessService {
  readonly leaseTtlMs: number;
  constructor(
    private readonly groups: GroupAccessService,
    @Inject(APP_CONFIG) config: EnvironmentConfig,
  ) {
    this.leaseTtlMs =
      config.sessionRealtime?.leaseTtlMs ?? CLASS_REALTIME_POLICY.leaseTtlMs;
  }

  async lockUsers(tx: Tx, ids: string[]) {
    for (const id of [...new Set(ids)].sort())
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR SHARE`;
  }

  async requireUser(tx: Tx, userId: string, lock = false) {
    if (lock) await this.lockUsers(tx, [userId]);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { globalRole: true, disabledAt: true },
    });
    if (!user || user.disabledAt)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Tài khoản không được phép truy cập.",
      );
    return user;
  }

  async load(tx: Tx, sessionId: string, mode?: "update" | "share") {
    const initial = await tx.classSession.findUnique({
      where: { id: sessionId },
    });
    if (!initial)
      throw new ApiError(404, "SESSION_NOT_FOUND", "Buổi học không tồn tại.");
    if (!mode) return initial;
    if (initial.groupId) {
      if (mode === "share")
        await tx.$queryRaw`SELECT id FROM groups WHERE id = ${initial.groupId}::uuid FOR SHARE`;
      else
        await tx.$queryRaw`SELECT id FROM groups WHERE id = ${initial.groupId}::uuid FOR UPDATE`;
    }
    if (mode === "share")
      await tx.$queryRaw`SELECT id FROM class_sessions WHERE id = ${sessionId}::uuid FOR SHARE`;
    else
      await tx.$queryRaw`SELECT id FROM class_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
    const fresh = await tx.classSession.findUnique({
      where: { id: sessionId },
    });
    if (!fresh)
      throw new ApiError(404, "SESSION_NOT_FOUND", "Buổi học không tồn tại.");
    return fresh;
  }

  /** Returns management rights; ordinary meet users are eligible to ask, not admitted. */
  async eligible(tx: Tx, userId: string, row: ClassSession): Promise<boolean> {
    const user = await this.requireUser(tx, userId);
    if (row.kind === "GROUP")
      return (await this.groups.require(userId, row.groupId!, undefined, tx))
        .canHost;
    return row.createdById === userId || user.globalRole === "ADMIN";
  }

  async activeVisit(tx: Tx, userId: string, row: ClassSession) {
    if (row.status !== "LIVE") return null;
    const visit = await tx.classParticipation.findFirst({
      where: {
        sessionId: row.id,
        userId,
        leftAt: null,
        OR: [{ joinRequestId: null }, { joinRequest: { status: "ACCEPTED" } }],
      },
    });
    return visit &&
      (await classVisitCurrent(
        tx,
        visit,
        await classServerTime(tx),
        this.leaseTtlMs,
      ))
      ? visit
      : null;
  }

  async authorize(tx: Tx, userId: string, row: ClassSession, manage: boolean) {
    const canManage = await this.eligible(tx, userId, row);
    if (
      canManage ||
      (!manage &&
        (row.kind === "GROUP" || (await this.activeVisit(tx, userId, row))))
    )
      return;
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Bạn không có quyền truy cập buổi học này.",
    );
  }
}
