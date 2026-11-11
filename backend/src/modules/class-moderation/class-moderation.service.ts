import { Injectable } from "@nestjs/common";
import type {
  ClassBanEntry,
  ClassBanResponse,
  ClassMuteResponse,
  CursorPage,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";
import type { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { revokeClassAccess } from "../../database/class-admission-revocation";
import { classServerTime } from "../../database/class-presence";
import { PrismaService } from "../../database/prisma.service";
import type { ClassSession, Prisma } from "../../generated/prisma/client";
import { ClassMediaService } from "../class-media/class-media.service";
import { ClassSessionAccessService } from "../class-sessions/class-session-access.service";
import {
  classSessionCursor,
  readClassSessionCursor,
} from "../class-sessions/class-session-cursor";

type Tx = Prisma.TransactionClient;
type ModerationEvent =
  "moderation.mute" | "moderation.changed" | "moderation.banned";

@Injectable()
export class ClassModerationService {
  constructor(
    private readonly db: PrismaService,
    private readonly access: ClassSessionAccessService,
    private readonly media: ClassMediaService,
  ) {}

  private manage<T>(
    actorId: string,
    sessionId: string,
    write: boolean,
    work: (tx: Tx, session: ClassSession) => Promise<T>,
    targetId?: string,
  ) {
    return this.db.$transaction(async (tx) => {
      await this.access.lockUsers(
        tx,
        targetId ? [actorId, targetId] : [actorId],
      );
      const session = await this.access.load(
        tx,
        sessionId,
        write ? "update" : "share",
      );
      await this.access.authorize(tx, actorId, session, true);
      return work(tx, session);
    });
  }

  private async target(
    tx: Tx,
    session: ClassSession,
    actorId: string,
    userId: string,
  ) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { globalRole: true },
    });
    if (!user) throw this.targetNotFound();
    const membership = session.groupId
      ? await tx.groupMember.findUnique({
          where: { userId_groupId: { userId, groupId: session.groupId } },
          select: { role: true },
        })
      : null;
    const owner = session.groupId
      ? (
          await tx.group.findUniqueOrThrow({
            where: { id: session.groupId },
            select: { ownerId: true },
          })
        ).ownerId
      : session.createdById;
    if (
      userId === actorId ||
      userId === owner ||
      user.globalRole === "ADMIN" ||
      (membership && membership.role !== "VIEWER")
    )
      throw new ApiError(
        409,
        "TARGET_PROTECTED",
        "Không thể áp dụng thao tác này với người quản lý phòng.",
      );
    return membership;
  }

  private targetNotFound() {
    return new ApiError(
      404,
      "PARTICIPANT_NOT_FOUND",
      "Không tìm thấy người tham gia buổi học này.",
    );
  }

  private async event(
    tx: Tx,
    sessionId: string,
    userId: string,
    event: ModerationEvent,
  ) {
    await tx.$executeRaw`SELECT class_realtime_change(${sessionId}::uuid, ${event}, ${userId}::uuid)`;
  }

  private async revokeMedia(tx: Tx, sessionId: string, userId: string) {
    // Token issuance takes a shared session lock. An in-flight issuance can no
    // longer activate its claim once the moderation transaction commits.
    await tx.classMediaConnection.updateMany({
      where: { sessionId, userId, state: { not: "REVOKED" } },
      data: {
        state: "REVOKING",
        tokenCiphertext: null,
        connected: false,
        checkedAt: new Date(),
      },
    });
    return this.pendingRevocations(tx, sessionId, userId);
  }

  private pendingRevocations(tx: Tx, sessionId: string, userId: string) {
    return tx.classMediaConnection.findMany({
      where: { sessionId, userId, state: "REVOKING" },
      include: { room: { select: { stageArn: true } } },
    });
  }

  private async disconnect(
    rows: Awaited<ReturnType<ClassModerationService["revokeMedia"]>>,
  ) {
    // The IVS worker retries rows that remain REVOKING after a provider failure.
    const results = await Promise.allSettled(
      rows.map(async ({ room, ...row }) => {
        if (!room.stageArn) throw new Error("MEDIA_STAGE_MISSING");
        return this.media.revoke(row, room.stageArn);
      }),
    );
    if (results.some(({ status }) => status === "rejected"))
      throw new ApiError(
        503,
        "MEDIA_REVOCATION_PENDING",
        "Đã lưu thay đổi. Hệ thống đang thử ngắt kết nối video lại.",
      );
  }

  async mute(
    actorId: string,
    sessionId: string,
    userId: string,
    lock?: boolean,
  ): Promise<ClassMuteResponse> {
    const { locked, rows } = await this.manage(
      actorId,
      sessionId,
      true,
      async (tx, session) => {
        if (session.status !== "LIVE")
          throw new ApiError(
            409,
            "SESSION_NOT_LIVE",
            "Buổi học chưa mở hoặc đã kết thúc.",
          );
        await this.target(tx, session, actorId, userId);
        const key = { sessionId_userId: { sessionId, userId } };
        const locked = !!(await tx.sessionMicLock.findUnique({ where: key }));
        if (
          !(await this.access.activeVisit(tx, userId, session)) &&
          !(locked && lock === false)
        )
          throw this.targetNotFound();
        if (lock === undefined) {
          await this.event(tx, sessionId, userId, "moderation.mute");
          return { locked, rows: [] };
        }
        if (lock !== locked) {
          if (lock)
            await tx.sessionMicLock.create({ data: { sessionId, userId } });
          else await tx.sessionMicLock.delete({ where: key });
          if (lock) await this.event(tx, sessionId, userId, "moderation.mute");
          await this.event(tx, sessionId, userId, "moderation.changed");
          return {
            locked: lock,
            rows: await this.revokeMedia(tx, sessionId, userId),
          };
        }
        // Retrying the same lock state must leave any replacement token usable.
        return {
          locked,
          rows: await this.pendingRevocations(tx, sessionId, userId),
        };
      },
      userId,
    );
    await this.disconnect(rows);
    return { userId, muted: true, locked };
  }

  async ban(
    actorId: string,
    sessionId: string,
    userId: string,
    reason?: string,
  ): Promise<ClassBanResponse> {
    const rows = await this.manage(
      actorId,
      sessionId,
      true,
      async (tx, session) => {
        const member = await this.target(tx, session, actorId, userId);
        const where = { sessionId_userId: { sessionId, userId } };
        const existing = await tx.sessionBan.findUnique({ where });
        if (!existing || existing.revokedAt) {
          if (
            !member &&
            !existing &&
            !(await tx.classParticipation.findFirst({
              where: { sessionId, userId },
              select: { id: true },
            })) &&
            !(await tx.classJoinRequest.findFirst({
              where: { sessionId, userId },
              select: { id: true },
            }))
          )
            throw this.targetNotFound();
          const now = await classServerTime(tx);
          const data = {
            bannedAt: now,
            reason: reason?.trim() || null,
            revokedAt: null,
          };
          await tx.sessionBan.upsert({
            where,
            create: { sessionId, userId, ...data },
            update: data,
          });
          await this.event(tx, sessionId, userId, "moderation.banned");
          await revokeClassAccess(tx, userId, now, { id: sessionId });
        }
        return this.revokeMedia(tx, sessionId, userId);
      },
      userId,
    );
    await this.disconnect(rows);
    return { userId, banned: true };
  }

  async unban(actorId: string, sessionId: string, userId: string) {
    await this.manage(
      actorId,
      sessionId,
      true,
      async (tx) => {
        await tx.sessionBan.updateMany({
          where: { sessionId, userId, revokedAt: null },
          data: { revokedAt: await classServerTime(tx) },
        });
      },
      userId,
    );
  }

  list(
    actorId: string,
    sessionId: string,
    query: PaginationQueryDto,
  ): Promise<CursorPage<ClassBanEntry>> {
    return this.manage(actorId, sessionId, false, async (tx) => {
      const scope = `bans:${sessionId}:${actorId}`;
      const cursor = readClassSessionCursor(query.cursor, scope);
      const rows = await tx.sessionBan.findMany({
        where: {
          sessionId,
          revokedAt: null,
          ...(cursor && {
            OR: [
              { bannedAt: { lt: cursor.at } },
              { bannedAt: cursor.at, userId: { lt: cursor.id } },
            ],
          }),
        },
        orderBy: [{ bannedAt: "desc" }, { userId: "desc" }],
        take: query.limit + 1,
        select: {
          userId: true,
          bannedAt: true,
          reason: true,
          user: { select: { fullName: true } },
        },
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(({ userId, user, reason, bannedAt }) => ({
          userId,
          fullName: user.fullName,
          reason,
          bannedAt: bannedAt.toISOString(),
        })),
        nextCursor:
          last && rows.length > query.limit
            ? classSessionCursor(scope, last.bannedAt, last.userId)
            : null,
      };
    });
  }
}
