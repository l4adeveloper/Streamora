import { Injectable } from "@nestjs/common";
import { randomInt } from "node:crypto";
import { isUUID } from "class-validator";
import type {
  ClassSession as StoredSession,
  Prisma,
} from "../../generated/prisma/client";
import { Prisma as PrismaRuntime } from "../../generated/prisma/client";
import type {
  ClassSession,
  ClassSessionResponse,
  ClassSessionListResponse,
  MeetPreviewResponse,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import { GroupAccessService } from "../memberships/group-access.service";
import { ClassSessionAccessService } from "./class-session-access.service";
import { ClassSessionCommandsService } from "./class-session-commands.service";
import type {
  CreateGroupClassSessionDto,
  CreateMeetDto,
  UpdateClassSessionDto,
  ClassSessionListQueryDto,
} from "./class-sessions.dto";

type Tx = Prisma.TransactionClient;
type Operation = "CREATE_GROUP" | "CREATE_MEET" | "START" | "END" | "CANCEL";
type Cursor = { scope: string; status: string | null; at: string; id: string };

export function toClassSession(row: StoredSession): ClassSession {
  const common = {
    id: row.id,
    createdById: row.createdById,
    title: row.title,
    description: row.description,
    joinCode: row.joinCode,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return row.kind === "GROUP"
    ? {
        ...common,
        kind: "GROUP",
        groupId: row.groupId!,
        scheduledAt: row.scheduledAt!.toISOString(),
      }
    : {
        ...common,
        kind: "MEET",
        groupId: null,
        scheduledAt: row.scheduledAt?.toISOString() ?? null,
      };
}

@Injectable()
export class ClassSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
    private readonly policy: ClassSessionAccessService,
    private readonly commands: ClassSessionCommandsService,
  ) {}

  private actor(tx: Tx, userId: string, lock = false) {
    return this.policy.requireUser(tx, userId, lock);
  }

  private authorize(
    tx: Tx,
    userId: string,
    row: StoredSession,
    manage: boolean,
  ) {
    return this.policy.authorize(tx, userId, row, manage);
  }

  private session(tx: Tx, sessionId: string, lock = false) {
    return this.policy.load(tx, sessionId, lock ? "update" : undefined);
  }

  private command(
    tx: Tx,
    userId: string,
    operation: Operation,
    key: string | undefined,
    body: unknown,
  ) {
    return this.commands.prepare(tx, userId, operation, key, body);
  }

  private saveCommand(
    tx: Tx,
    userId: string,
    operation: Operation,
    key: string | undefined,
    bodyHash: string,
    response: ClassSessionResponse,
  ) {
    return this.commands.save(
      tx,
      userId,
      operation,
      key,
      bodyHash,
      response.session.id,
      response,
    );
  }

  createGroup(
    userId: string,
    groupId: string,
    dto: CreateGroupClassSessionDto,
    key?: string,
  ) {
    return this.create(userId, groupId, dto, key);
  }
  createMeet(userId: string, dto: CreateMeetDto, key?: string) {
    return this.create(userId, null, dto, key);
  }

  private async create(
    userId: string,
    groupId: string | null,
    dto: CreateMeetDto,
    key?: string,
  ): Promise<ClassSessionResponse> {
    const operation = groupId ? "CREATE_GROUP" : "CREATE_MEET";
    const input = {
      groupId,
      title: dto.title.trim(),
      description: dto.description?.trim() || null,
      scheduledAt: dto.scheduledAt
        ? new Date(dto.scheduledAt).toISOString()
        : null,
    };
    // A rare discovery-code collision retries the whole transaction with a new code.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await this.actor(tx, userId, true);
            const command = await this.command(
              tx,
              userId,
              operation,
              key,
              input,
            );
            if (groupId) {
              await tx.$queryRaw`SELECT id FROM groups WHERE id = ${groupId}::uuid FOR UPDATE`;
              await this.access.require(userId, groupId, "canHost", tx);
            }
            if (command.previous) {
              const current = await this.session(
                tx,
                command.previous.sessionId,
              );
              await this.authorize(tx, userId, current, true);
              return command.previous
                .response as unknown as ClassSessionResponse;
            }
            const joinCode = Array.from({ length: 12 }, () =>
              randomInt(36).toString(36).toUpperCase(),
            ).join("");
            const row = await tx.classSession.create({
              data: {
                kind: groupId ? "GROUP" : "MEET",
                groupId,
                createdById: userId,
                title: input.title,
                description: input.description,
                joinCode,
                scheduledAt: input.scheduledAt
                  ? new Date(input.scheduledAt)
                  : null,
              },
            });
            const response = { session: toClassSession(row) };
            await this.saveCommand(
              tx,
              userId,
              operation,
              key,
              command.bodyHash,
              response,
            );
            return response;
          },
          { timeout: 10000 },
        );
      } catch (error) {
        if (
          !(error instanceof PrismaRuntime.PrismaClientKnownRequestError) ||
          error.code !== "P2002" ||
          attempt >= 2
        )
          throw error;
      }
    }
  }

  private cursor(
    query: ClassSessionListQueryDto,
    scope: string,
  ): Cursor | null {
    if (!query.cursor) return null;
    try {
      if (!/^[\w-]+$/.test(query.cursor)) throw new Error();
      const parsed = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString(),
      ) as Cursor;
      if (
        !parsed ||
        parsed.scope !== scope ||
        parsed.status !== (query.status ?? null) ||
        !isUUID(parsed.id) ||
        typeof parsed.at !== "string" ||
        new Date(parsed.at).toISOString() !== parsed.at
      )
        throw new Error();
      return parsed;
    } catch {
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "Con trỏ phân trang không hợp lệ.",
      );
    }
  }

  listGroup(userId: string, groupId: string, query: ClassSessionListQueryDto) {
    return this.list(userId, groupId, query);
  }
  listMine(userId: string, query: ClassSessionListQueryDto) {
    return this.list(userId, null, query);
  }
  private list(
    userId: string,
    groupId: string | null,
    query: ClassSessionListQueryDto,
  ): Promise<ClassSessionListResponse> {
    const scope = groupId ? `group:${groupId}:${userId}` : `mine:${userId}`;
    const cursor = this.cursor(query, scope);
    return this.prisma.$transaction(async (tx) => {
      await this.actor(tx, userId);
      if (groupId) await this.access.require(userId, groupId, undefined, tx);
      const timeField = groupId ? "scheduledAt" : "createdAt";
      const comparison = groupId ? "gt" : "lt";
      const where: Prisma.ClassSessionWhereInput = {
        ...(groupId
          ? { groupId, kind: "GROUP" }
          : { kind: "MEET", createdById: userId }),
        ...(query.status ? { status: query.status } : {}),
        ...(cursor
          ? {
              OR: [
                { [timeField]: { [comparison]: new Date(cursor.at) } },
                {
                  [timeField]: new Date(cursor.at),
                  id: { [comparison]: cursor.id },
                },
              ],
            }
          : {}),
      };
      const rows = await tx.classSession.findMany({
        where,
        orderBy: [
          { [timeField]: groupId ? "asc" : "desc" },
          { id: groupId ? "asc" : "desc" },
        ],
        take: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                scope,
                status: query.status ?? null,
                at: last[timeField]!.toISOString(),
                id: last.id,
              }),
            ).toString("base64url")
          : null;
      return { items: items.map(toClassSession), nextCursor };
    });
  }

  find(userId: string, sessionId: string): Promise<ClassSessionResponse> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.session(tx, sessionId);
      await this.authorize(tx, userId, row, false);
      return { session: toClassSession(row) };
    });
  }

  preview(userId: string, code: string): Promise<MeetPreviewResponse> {
    if (!/^[A-Z0-9]{12}$/.test(code))
      throw new ApiError(400, "VALIDATION_ERROR", "Mã phòng không hợp lệ.");
    return this.prisma.$transaction(async (tx) => {
      await this.actor(tx, userId);
      const row = await tx.classSession.findUnique({
        where: { joinCode: code },
        include: { createdBy: { select: { id: true, fullName: true } } },
      });
      if (!row || row.kind !== "MEET")
        throw new ApiError(404, "SESSION_NOT_FOUND", "Phòng không tồn tại.");
      return {
        meet: {
          id: row.id,
          title: row.title,
          host: row.createdBy,
          status: row.status,
        },
      };
    });
  }

  update(
    userId: string,
    sessionId: string,
    dto: UpdateClassSessionDto,
  ): Promise<ClassSessionResponse> {
    return this.prisma.$transaction(async (tx) => {
      await this.actor(tx, userId, true);
      const row = await this.session(tx, sessionId, true);
      await this.authorize(tx, userId, row, true);
      if (row.status !== "SCHEDULED")
        throw new ApiError(
          409,
          "SESSION_NOT_EDITABLE",
          "Chỉ sửa được buổi học chưa bắt đầu.",
        );
      if (row.kind === "GROUP" && dto.scheduledAt === null)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Buổi học theo nhóm phải có lịch dự kiến.",
        );
      const data: Prisma.ClassSessionUpdateInput = {};
      if (dto.title !== undefined) data.title = dto.title.trim();
      if (dto.description !== undefined)
        data.description = dto.description?.trim() || null;
      if (dto.scheduledAt !== undefined)
        data.scheduledAt =
          dto.scheduledAt === null ? null : new Date(dto.scheduledAt);
      const result = Object.keys(data).length
        ? await tx.classSession.update({ where: { id: sessionId }, data })
        : row;
      return { session: toClassSession(result) };
    });
  }

  transition(
    userId: string,
    sessionId: string,
    operation: "START" | "END" | "CANCEL",
    key?: string,
  ): Promise<ClassSessionResponse> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.actor(tx, userId, true);
        const command = await this.command(tx, userId, operation, key, {
          sessionId,
        });
        const row = await this.session(tx, sessionId, true);
        await this.authorize(tx, userId, row, true);
        const target =
          operation === "START"
            ? "LIVE"
            : operation === "END"
              ? "ENDED"
              : "CANCELLED";
        if (row.status === target) {
          const response = { session: toClassSession(row) };
          if (!command.previous)
            await this.saveCommand(
              tx,
              userId,
              operation,
              key,
              command.bodyHash,
              response,
            );
          return response;
        }
        if (row.status !== (operation === "END" ? "LIVE" : "SCHEDULED"))
          throw new ApiError(
            409,
            "INVALID_SESSION_STATE",
            "Không thể chuyển trạng thái buổi học.",
          );
        const [clock] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT clock_timestamp() AS now`;
        const now = clock.now;
        const updated = await tx.classSession.update({
          where: { id: sessionId },
          data: {
            status: target,
            ...(operation === "START"
              ? { startedAt: now }
              : operation === "END"
                ? { endedAt: now }
                : { cancelledAt: now }),
          },
        });
        if (operation === "END") {
          await tx.classJoinRequest.updateMany({
            where: { sessionId, status: { in: ["PENDING", "ACCEPTED"] } },
            data: { status: "EXPIRED", closedAt: now },
          });
          await tx.classParticipation.updateMany({
            where: { sessionId, leftAt: null },
            data: { leftAt: now, leaveReason: "SESSION_ENDED" },
          });
          // Allocate versions through commit, including ends of different sessions.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(73004)::text`;
          await tx.classSessionEndEvent.create({
            data: { sessionId, endedAt: now },
          });
        }
        const response = { session: toClassSession(updated) };
        if (!command.previous)
          await this.saveCommand(
            tx,
            userId,
            operation,
            key,
            command.bodyHash,
            response,
          );
        return response;
      },
      { timeout: 10000 },
    );
  }
}
