import { Injectable } from "@nestjs/common";
import type {
  ClassPoll,
  ClassPollResponse,
  ClassPollUpdated,
  CreateClassPollRequest,
  CursorPage,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";
import type { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { classServerTime } from "../../database/class-presence";
import { PrismaService } from "../../database/prisma.service";
import {
  Prisma,
  type ClassPoll as PollRow,
  type ClassSession,
} from "../../generated/prisma/client";
import { ClassSessionAccessService } from "../class-sessions/class-session-access.service";
import {
  classSessionCursor,
  readClassSessionCursor,
} from "../class-sessions/class-session-cursor";

type Tx = Prisma.TransactionClient;

@Injectable()
export class PollsService {
  constructor(
    private readonly db: PrismaService,
    private readonly access: ClassSessionAccessService,
  ) {}

  private async session(
    tx: Tx,
    userId: string,
    sessionId: string,
    manage: boolean,
  ) {
    // Hold the same locks as admission so membership, bans and session ending
    // cannot change the authorization or lifecycle during the operation.
    await this.access.lockUsers(tx, [userId]);
    const session = await this.access.load(tx, sessionId, "share");
    const canManage = await this.access.eligible(tx, userId, session);
    const allowed = manage
      ? canManage
      : await this.access.canViewPolls(tx, userId, session, canManage);
    if (!allowed)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn không có quyền thực hiện thao tác bình chọn này.",
      );
    return session;
  }

  private async read(
    tx: Tx,
    userId: string,
    ids: string[],
  ): Promise<ClassPoll[]> {
    if (!ids.length) return [];
    // The public totals, version and caller's private choice share one SQL snapshot.
    const rows = await tx.$queryRaw<
      { publicPoll: ClassPollUpdated; myOptionId: string | null }[]
    >`
      SELECT class_poll_public(p.id) AS "publicPoll", v.option_id AS "myOptionId"
      FROM class_polls p
      LEFT JOIN class_poll_votes v ON v.poll_id = p.id AND v.user_id = ${userId}::uuid
      WHERE p.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY p.created_at DESC, p.id DESC
    `;
    return rows.map(({ publicPoll: { pollId, ...poll }, myOptionId }) => ({
      ...poll,
      id: pollId,
      myOptionId,
    }));
  }

  private async changed(tx: Tx, pollId: string) {
    await tx.$executeRaw`SELECT class_poll_changed(${pollId}::uuid)`;
  }

  create(
    userId: string,
    sessionId: string,
    input: CreateClassPollRequest,
  ): Promise<ClassPollResponse> {
    return this.db.$transaction(async (tx) => {
      const session = await this.session(tx, userId, sessionId, true);
      if (session.status !== "LIVE")
        throw new ApiError(
          409,
          "SESSION_NOT_LIVE",
          "Buổi học chưa mở hoặc đã kết thúc.",
        );
      const poll = await tx.classPoll.create({
        data: {
          sessionId,
          createdById: userId,
          question: input.question,
          options: {
            create: input.options.map(({ text }, position) => ({
              text,
              position,
            })),
          },
        },
      });
      await this.changed(tx, poll.id);
      const [result] = await this.read(tx, userId, [poll.id]);
      return { poll: result };
    });
  }

  list(
    userId: string,
    sessionId: string,
    query: PaginationQueryDto,
  ): Promise<CursorPage<ClassPoll>> {
    return this.db.$transaction(async (tx) => {
      await this.session(tx, userId, sessionId, false);
      const scope = `polls:${sessionId}:${userId}`;
      const cursor = readClassSessionCursor(query.cursor, scope);
      const rows = await tx.classPoll.findMany({
        where: {
          sessionId,
          ...(cursor && {
            OR: [
              { createdAt: { lt: cursor.at } },
              { createdAt: cursor.at, id: { lt: cursor.id } },
            ],
          }),
        },
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: await this.read(
          tx,
          userId,
          page.map(({ id }) => id),
        ),
        nextCursor:
          last && rows.length > query.limit
            ? classSessionCursor(scope, last.createdAt, last.id)
            : null,
      };
    });
  }

  private update(
    userId: string,
    pollId: string,
    manage: boolean,
    mutate: (tx: Tx, poll: PollRow, session: ClassSession) => Promise<boolean>,
  ): Promise<ClassPollResponse> {
    return this.db.$transaction(async (tx) => {
      const target = await tx.classPoll.findUnique({
        where: { id: pollId },
        select: { sessionId: true },
      });
      if (!target)
        throw new ApiError(404, "POLL_NOT_FOUND", "Không tìm thấy bình chọn.");
      const session = await this.session(tx, userId, target.sessionId, manage);
      // A vote or close reads the committed state after obtaining the same row lock.
      await tx.$queryRaw`SELECT id FROM class_polls WHERE id = ${pollId}::uuid FOR UPDATE`;
      const poll = await tx.classPoll.findUniqueOrThrow({
        where: { id: pollId },
      });
      if (await mutate(tx, poll, session)) {
        await tx.classPoll.update({
          where: { id: pollId },
          data: { version: { increment: 1 } },
        });
        await this.changed(tx, pollId);
      }
      const [result] = await this.read(tx, userId, [pollId]);
      return { poll: result };
    });
  }

  vote(userId: string, pollId: string, optionId: string) {
    return this.update(userId, pollId, false, async (tx, poll, session) => {
      if (poll.status !== "OPEN" || session.status !== "LIVE")
        throw new ApiError(409, "POLL_CLOSED", "Bình chọn đã đóng.");
      const option = await tx.classPollOption.findUnique({
        where: { pollId_id: { pollId, id: optionId } },
        select: { id: true },
      });
      if (!option)
        throw new ApiError(
          400,
          "OPTION_NOT_IN_POLL",
          "Lựa chọn không thuộc bình chọn này.",
        );
      const where = { pollId_userId: { pollId, userId } };
      const existing = await tx.classPollVote.findUnique({
        where,
        select: { optionId: true },
      });
      if (existing?.optionId === optionId) return false;
      await tx.classPollVote.upsert({
        where,
        create: { pollId, userId, optionId },
        update: { optionId },
      });
      return true;
    });
  }

  close(userId: string, pollId: string) {
    return this.update(userId, pollId, true, async (tx, poll) => {
      if (poll.status === "CLOSED") return false;
      await tx.classPoll.update({
        where: { id: pollId },
        data: { status: "CLOSED", closedAt: await classServerTime(tx) },
      });
      return true;
    });
  }
}
