import { Injectable } from "@nestjs/common";
import { isUUID } from "class-validator";
import type {
  Prisma,
  ClassSession,
  ClassJoinRequest as RequestRow,
  ClassParticipation as VisitRow,
} from "../../generated/prisma/client";
import type {
  ClassJoinRequest,
  ClassParticipation,
  ClassAdmissionResponse,
  ClassJoinRequestResponse,
  ClassJoinRequestListResponse,
  ClassParticipationResponse,
  ClassParticipationListResponse,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import { revokeClassAccess } from "../../database/class-admission-revocation";
import {
  classServerTime,
  classVisitCurrent,
  closeClassVisit,
  validClassLease,
} from "../../database/class-presence";
import { ClassSessionAccessService } from "./class-session-access.service";
import {
  ClassSessionCommandsService,
  type ClassSessionOperation,
} from "./class-session-commands.service";
import type {
  ClassJoinRequestListQueryDto,
  DecideClassJoinDto,
} from "./class-admissions.dto";
import type { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

type Tx = Prisma.TransactionClient;
type Prepared = Awaited<ReturnType<ClassSessionCommandsService["prepare"]>>;

export function toClassJoinRequest(row: RequestRow): ClassJoinRequest {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedById: row.decidedById,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}
export function toClassParticipation(row: VisitRow): ClassParticipation {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    joinRequestId: row.joinRequestId,
    joinedAt: row.joinedAt.toISOString(),
    leftAt: row.leftAt?.toISOString() ?? null,
    leaveReason: row.leaveReason,
  };
}

@Injectable()
export class ClassAdmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ClassSessionAccessService,
    private readonly commands: ClassSessionCommandsService,
  ) {}

  private async withSession<T>(
    userId: string,
    sessionId: string,
    write: boolean,
    work: (
      tx: Tx,
      row: ClassSession,
      manage: boolean,
      command: Prepared | null,
    ) => Promise<T>,
    options: {
      targetUsers?: string[];
      operation?: ClassSessionOperation;
      key?: string;
    } = {},
  ) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.access.lockUsers(tx, [
          userId,
          ...(options.targetUsers ?? []),
        ]);
        await this.access.requireUser(tx, userId);
        const command = options.operation
          ? await this.commands.prepare(
              tx,
              userId,
              options.operation,
              options.key,
              { sessionId },
              true,
            )
          : null;
        const row = await this.access.load(
          tx,
          sessionId,
          write ? "update" : "share",
        );
        const manage = await this.access.eligible(tx, userId, row);
        let cleaned = false;
        if (write) {
          const visit = await tx.classParticipation.findFirst({
            where: { sessionId, userId, leftAt: null },
            include: { joinRequest: true },
          });
          const now = await classServerTime(tx);
          const revoked =
            visit?.joinRequest && visit.joinRequest.status !== "ACCEPTED";
          if (
            visit &&
            (revoked ||
              !(await classVisitCurrent(
                tx,
                visit,
                now,
                this.access.leaseTtlMs,
              )))
          ) {
            await closeClassVisit(
              tx,
              visit,
              now,
              revoked ? "ACCESS_REVOKED" : "DISCONNECTED",
            );
            cleaned = true;
          }
        }
        try {
          return await work(tx, row, manage, command);
        } catch (error) {
          // A failed retry must not roll back expiration of its old admission.
          if (cleaned && error instanceof ApiError) return error;
          throw error;
        }
      },
      { timeout: 10000 },
    );
    if (result instanceof ApiError) throw result;
    return result as T;
  }
  private live(row: ClassSession) {
    if (row.status !== "LIVE")
      throw new ApiError(
        409,
        "SESSION_NOT_LIVE",
        "Buổi học chưa mở hoặc đã kết thúc.",
      );
  }
  private manager(manage: boolean) {
    if (!manage)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Chỉ người quản lý được xem hoặc duyệt hàng chờ.",
      );
  }
  private async now(tx: Tx) {
    const [clock] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    return clock.now;
  }
  private request(tx: Tx, sessionId: string, userId: string) {
    return tx.classJoinRequest.findFirst({
      where: { sessionId, userId, status: { in: ["PENDING", "ACCEPTED"] } },
    });
  }
  private async requestById(tx: Tx, sessionId: string, requestId: string) {
    const row = await tx.classJoinRequest.findFirst({
      where: { id: requestId, sessionId },
    });
    if (!row)
      throw new ApiError(
        404,
        "JOIN_REQUEST_NOT_FOUND",
        "Yêu cầu tham gia không tồn tại.",
      );
    return row;
  }

  state(userId: string, sessionId: string): Promise<ClassAdmissionResponse> {
    return this.withSession(
      userId,
      sessionId,
      false,
      async (tx, row, manage) => {
        const request =
          (await this.request(tx, sessionId, userId)) ??
          (await tx.classJoinRequest.findFirst({
            where: { sessionId, userId },
            orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
          }));
        const active = await this.access.activeVisit(tx, userId, row);
        const consumed =
          !!request &&
          !!(await tx.classParticipation.findUnique({
            where: { joinRequestId: request.id },
            select: { id: true },
          }));
        const visit =
          active ??
          (await tx.classParticipation.findFirst({
            where: { sessionId, userId },
            orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
          }));
        return {
          request: request ? toClassJoinRequest(request) : null,
          participation: visit ? toClassParticipation(visit) : null,
          permissions: {
            canManage: manage,
            canRequestJoin:
              row.status === "LIVE" &&
              !manage &&
              !active &&
              (!request ||
                !["PENDING", "ACCEPTED"].includes(request.status) ||
                (consumed && !active)),
            canEnter:
              row.status === "LIVE" &&
              (manage ||
                !!active ||
                (request?.status === "ACCEPTED" && !consumed)),
            canViewParticipants: manage || !!active,
          },
        };
      },
    );
  }

  requestJoin(
    userId: string,
    sessionId: string,
    key?: string,
  ): Promise<ClassJoinRequestResponse> {
    return this.withSession(
      userId,
      sessionId,
      true,
      async (tx, row, manage, command) => {
        this.live(row);
        if (command!.previous) {
          const previous = command!.previous
            .response as unknown as ClassJoinRequestResponse;
          const request = await this.requestById(
            tx,
            sessionId,
            previous.request.id,
          );
          if (request.userId !== userId)
            throw new ApiError(403, "FORBIDDEN", "Không có quyền đọc yêu cầu.");
          return { request: toClassJoinRequest(request) };
        }
        if (manage || (await this.access.activeVisit(tx, userId, row)))
          throw new ApiError(
            409,
            "JOIN_REQUEST_NOT_REQUIRED",
            "Bạn có thể vào trực tiếp hoặc đã ở trong phòng.",
          );
        const request =
          (await this.request(tx, sessionId, userId)) ??
          (await tx.classJoinRequest.create({
            data: { sessionId, userId, requestedAt: await this.now(tx) },
          }));
        const response = { request: toClassJoinRequest(request) };
        await this.commands.save(
          tx,
          userId,
          "REQUEST_JOIN",
          key,
          command!.bodyHash,
          sessionId,
          response,
        );
        return response;
      },
      { operation: "REQUEST_JOIN", key },
    );
  }

  findRequest(
    userId: string,
    sessionId: string,
    requestId: string,
  ): Promise<ClassJoinRequestResponse> {
    return this.withSession(
      userId,
      sessionId,
      false,
      async (tx, _row, manage) => {
        const request = await this.requestById(tx, sessionId, requestId);
        if (!manage && request.userId !== userId)
          throw new ApiError(
            403,
            "FORBIDDEN",
            "Chỉ xem được yêu cầu của chính mình.",
          );
        return { request: toClassJoinRequest(request) };
      },
    );
  }

  cancelRequest(
    userId: string,
    sessionId: string,
    requestId: string,
  ): Promise<ClassJoinRequestResponse> {
    return this.withSession(userId, sessionId, true, async (tx, row) => {
      const request = await this.requestById(tx, sessionId, requestId);
      if (request.userId !== userId)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Chỉ hủy được yêu cầu của chính mình.",
        );
      if (request.status === "CANCELLED")
        return { request: toClassJoinRequest(request) };
      this.live(row);
      if (request.status !== "PENDING")
        throw new ApiError(
          409,
          "JOIN_REQUEST_ALREADY_RESOLVED",
          "Yêu cầu không còn chờ duyệt.",
        );
      const result = await tx.classJoinRequest.update({
        where: { id: requestId },
        data: { status: "CANCELLED", closedAt: await this.now(tx) },
      });
      return { request: toClassJoinRequest(result) };
    });
  }

  async decide(
    userId: string,
    sessionId: string,
    requestId: string,
    dto: DecideClassJoinDto,
  ): Promise<ClassJoinRequestResponse> {
    // Immutable target is discovered first so every user lock is acquired in UUID order.
    const target = await this.prisma.classJoinRequest.findFirst({
      where: { id: requestId, sessionId },
      select: { userId: true },
    });
    const result = await this.withSession(
      userId,
      sessionId,
      true,
      async (tx, row, manage) => {
        this.manager(manage);
        this.live(row);
        const request = await this.requestById(tx, sessionId, requestId);
        try {
          await this.access.eligible(tx, request.userId, row);
        } catch (error) {
          if (!(error instanceof ApiError) || error.getStatus() !== 403)
            throw error;
          await revokeClassAccess(tx, request.userId, await this.now(tx), {
            id: sessionId,
          });
          return new ApiError(
            403,
            "ADMISSION_REVOKED",
            "Người xin vào không còn đủ điều kiện tham gia.",
          );
        }
        const status = dto.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED";
        if (request.status === status)
          return { request: toClassJoinRequest(request) };
        if (request.status !== "PENDING")
          throw new ApiError(
            409,
            "JOIN_REQUEST_ALREADY_RESOLVED",
            "Yêu cầu đã có kết quả hoặc không còn hiệu lực.",
          );
        const now = await this.now(tx);
        const updated = await tx.classJoinRequest.update({
          where: { id: requestId },
          data: {
            status,
            decidedAt: now,
            decidedById: userId,
            ...(status === "REJECTED" ? { closedAt: now } : {}),
          },
        });
        return { request: toClassJoinRequest(updated) };
      },
      { targetUsers: target ? [target.userId] : [] },
    );
    // Commit revocation before reporting the failed eligibility check.
    if (result instanceof ApiError) throw result;
    return result;
  }

  enter(
    userId: string,
    sessionId: string,
    key?: string,
  ): Promise<ClassParticipationResponse> {
    return this.withSession(
      userId,
      sessionId,
      true,
      async (tx, row, manage, command) => {
        this.live(row);
        const active = await this.access.activeVisit(tx, userId, row);
        if (command!.previous) {
          const previous = command!.previous
            .response as unknown as ClassParticipationResponse;
          if (!active || active.id !== previous.participation.id)
            throw new ApiError(
              403,
              "ADMISSION_REVOKED",
              "Lượt tham gia cũ đã kết thúc; cần một thao tác vào mới.",
            );
          return { participation: toClassParticipation(active) };
        }
        let visit = active;
        if (!visit) {
          const request = await this.request(tx, sessionId, userId);
          if (!manage && request?.status !== "ACCEPTED")
            throw new ApiError(
              403,
              "ADMISSION_REQUIRED",
              "Bạn cần được chấp nhận trước khi vào phòng.",
            );
          const now = await this.now(tx);
          if (manage && request)
            await tx.classJoinRequest.update({
              where: { id: request.id },
              data: { status: "EXPIRED", closedAt: now },
            });
          visit = await tx.classParticipation.create({
            data: {
              sessionId,
              userId,
              joinRequestId: manage ? null : request!.id,
              joinedAt: now,
              lastSeenAt: now,
            },
          });
        }
        const response = { participation: toClassParticipation(visit) };
        await this.commands.save(
          tx,
          userId,
          "ENTER_SESSION",
          key,
          command!.bodyHash,
          sessionId,
          response,
        );
        return response;
      },
      { operation: "ENTER_SESSION", key },
    );
  }

  leave(
    userId: string,
    sessionId: string,
    participationId: string,
  ): Promise<ClassParticipationResponse> {
    return this.withSession(userId, sessionId, true, async (tx) => {
      const visit = await tx.classParticipation.findFirst({
        where: { id: participationId, sessionId },
      });
      if (!visit)
        throw new ApiError(
          404,
          "PARTICIPATION_NOT_FOUND",
          "Lượt tham gia không tồn tại.",
        );
      if (visit.userId !== userId)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Chỉ rời được lượt tham gia của chính mình.",
        );
      if (visit.leftAt) return { participation: toClassParticipation(visit) };
      const now = await this.now(tx);
      if (visit.joinRequestId)
        await tx.classJoinRequest.updateMany({
          where: { id: visit.joinRequestId, status: "ACCEPTED" },
          data: { status: "EXPIRED", closedAt: now },
        });
      const result = await tx.classParticipation.update({
        where: { id: visit.id },
        data: { leftAt: now, leaveReason: "LEFT" },
      });
      return { participation: toClassParticipation(result) };
    });
  }

  private cursor(query: PaginationQueryDto, scope: string) {
    if (!query.cursor) return null;
    try {
      if (!/^[\w-]+$/.test(query.cursor)) throw new Error();
      const value = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString(),
      ) as { scope: string; at: string; id: string };
      if (
        !value ||
        value.scope !== scope ||
        !isUUID(value.id) ||
        typeof value.at !== "string" ||
        new Date(value.at).toISOString() !== value.at
      )
        throw new Error();
      return { at: new Date(value.at), id: value.id };
    } catch {
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "Con trỏ phân trang không hợp lệ.",
      );
    }
  }
  private next(scope: string, at: Date, id: string) {
    return Buffer.from(
      JSON.stringify({ scope, at: at.toISOString(), id }),
    ).toString("base64url");
  }

  listRequests(
    userId: string,
    sessionId: string,
    query: ClassJoinRequestListQueryDto,
  ): Promise<ClassJoinRequestListResponse> {
    const scope = `requests:${sessionId}:${userId}:${query.status}`;
    const after = this.cursor(query, scope);
    return this.withSession(
      userId,
      sessionId,
      false,
      async (tx, _row, manage) => {
        this.manager(manage);
        const rows = await tx.classJoinRequest.findMany({
          where: {
            sessionId,
            status: query.status,
            ...(after
              ? {
                  OR: [
                    { requestedAt: { gt: after.at } },
                    { requestedAt: after.at, id: { gt: after.id } },
                  ],
                }
              : {}),
          },
          include: { user: { select: { id: true, fullName: true } } },
          orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
          take: query.limit + 1,
        });
        const items = rows.slice(0, query.limit),
          last = items.at(-1);
        return {
          items: items.map((row) => ({
            ...toClassJoinRequest(row),
            user: row.user,
          })),
          nextCursor:
            rows.length > query.limit && last
              ? this.next(scope, last.requestedAt, last.id)
              : null,
        };
      },
    );
  }

  participants(
    userId: string,
    sessionId: string,
    query: PaginationQueryDto,
  ): Promise<ClassParticipationListResponse> {
    const scope = `participants:${sessionId}:${userId}`;
    const after = this.cursor(query, scope);
    return this.withSession(
      userId,
      sessionId,
      false,
      async (tx, row, manage) => {
        if (!manage && !(await this.access.activeVisit(tx, userId, row)))
          throw new ApiError(
            403,
            "ADMISSION_REQUIRED",
            "Chỉ người đã vào phòng hoặc người quản lý được xem danh sách.",
          );
        const group = row.groupId
          ? await tx.group.findUniqueOrThrow({
              where: { id: row.groupId },
              select: { ownerId: true },
            })
          : null;
        const now = await classServerTime(tx);
        const rows = await tx.classParticipation.findMany({
          where: {
            sessionId,
            leftAt: null,
            AND: [
              {
                OR: [
                  {
                    lastSeenAt: {
                      gt: new Date(now.getTime() - this.access.leaseTtlMs),
                    },
                  },
                  { leases: { some: validClassLease(now) } },
                ],
              },
              {
                OR: [
                  { joinRequestId: null },
                  { joinRequest: { status: "ACCEPTED" } },
                ],
              },
              ...(after
                ? [
                    {
                      OR: [
                        { joinedAt: { gt: after.at } },
                        { joinedAt: after.at, id: { gt: after.id } },
                      ],
                    },
                  ]
                : []),
            ],
            user: {
              disabledAt: null,
              ...(group
                ? {
                    OR: [
                      { globalRole: "ADMIN" },
                      { id: group.ownerId },
                      {
                        memberships: {
                          some: {
                            groupId: row.groupId!,
                            role: { in: ["HOST", "VIEWER"] },
                          },
                        },
                      },
                    ],
                  }
                : {}),
            },
          },
          include: { user: { select: { id: true, fullName: true } } },
          orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
          take: query.limit + 1,
        });
        const items = rows.slice(0, query.limit),
          last = items.at(-1);
        return {
          items: items.map((visit) => ({
            ...toClassParticipation(visit),
            user: visit.user,
          })),
          nextCursor:
            rows.length > query.limit && last
              ? this.next(scope, last.joinedAt, last.id)
              : null,
        };
      },
    );
  }
}
