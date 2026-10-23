import { Injectable } from "@nestjs/common";
import { revokeClassAccess } from "../../database/class-admission-revocation";
import { isUUID } from "class-validator";
import type {
  Membership,
  MembershipListResponse,
  UserLookupResponse,
} from "@streamora/contracts";
import type { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { ApiError } from "../../common/api-error";
import { GroupAccessService } from "./group-access.service";
import type {
  AddMemberDto,
  ChangeMemberRoleDto,
  MemberListQueryDto,
  UserLookupQueryDto,
} from "./memberships.dto";

const MEMBER_SELECT = {
  userId: true,
  role: true,
  joinedAt: true,
  user: { select: { fullName: true, email: true } },
} as const;
function membership(row: {
  userId: string;
  role: Membership["role"];
  joinedAt: Date;
  user: { fullName: string; email: string };
}): Membership {
  return {
    userId: row.userId,
    fullName: row.user.fullName,
    email: row.user.email,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  };
}

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
  ) {}

  async lookup(
    actorId: string,
    query: UserLookupQueryDto,
  ): Promise<UserLookupResponse> {
    await this.access.require(actorId, query.groupId, "canManageMembers");
    // Atomic, shared by every instance, bounded to one row per authenticated user.
    const [window] = await this.prisma.$queryRaw<{ attempts: number }[]>`
      INSERT INTO membership_lookup_windows (user_id, window_start, attempts)
      VALUES (${actorId}::uuid, clock_timestamp(), 1)
      ON CONFLICT (user_id) DO UPDATE SET
        attempts = CASE WHEN membership_lookup_windows.window_start <= clock_timestamp() - interval '1 minute'
          THEN 1 ELSE LEAST(membership_lookup_windows.attempts + 1, 31) END,
        window_start = CASE WHEN membership_lookup_windows.window_start <= clock_timestamp() - interval '1 minute'
          THEN clock_timestamp() ELSE membership_lookup_windows.window_start END
      RETURNING attempts`;
    if (window.attempts > 30)
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Bạn đã tra cứu quá nhiều. Vui lòng thử lại sau một phút.",
      );
    const user = await this.prisma.user.findFirst({
      where: { email: query.email, disabledAt: null },
      select: { id: true, fullName: true, email: true },
    });
    return { user };
  }

  async list(
    actorId: string,
    groupId: string,
    query: MemberListQueryDto,
  ): Promise<MembershipListResponse> {
    await this.access.require(actorId, groupId);
    let after: { joinedAt: Date; userId: string } | undefined;
    if (query.cursor) {
      try {
        if (!/^[\w-]+$/.test(query.cursor)) throw new Error();
        const value = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString(),
        );
        if (
          value.groupId !== groupId ||
          value.q !== (query.q ?? "") ||
          !isUUID(value.userId) ||
          typeof value.joinedAt !== "string" ||
          new Date(value.joinedAt).toISOString() !== value.joinedAt
        )
          throw new Error();
        after = { userId: value.userId, joinedAt: new Date(value.joinedAt) };
      } catch {
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "Con trỏ phân trang không hợp lệ.",
        );
      }
    }
    const rows = await this.prisma.groupMember.findMany({
      where: {
        groupId,
        AND: [
          ...(query.q
            ? [
                {
                  user: {
                    OR: [
                      {
                        fullName: {
                          contains: query.q,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        email: {
                          contains: query.q,
                          mode: "insensitive" as const,
                        },
                      },
                    ],
                  },
                },
              ]
            : []),
          ...(after
            ? [
                {
                  OR: [
                    { joinedAt: { gt: after.joinedAt } },
                    { joinedAt: after.joinedAt, userId: { gt: after.userId } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
      take: query.limit + 1,
      select: MEMBER_SELECT,
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map(membership),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                groupId,
                q: query.q ?? "",
                userId: last.userId,
                joinedAt: last.joinedAt.toISOString(),
              }),
            ).toString("base64url")
          : null,
    };
  }

  add(actorId: string, groupId: string, dto: AddMemberDto) {
    return this.mutate(actorId, groupId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: dto.userId, disabledAt: null },
        select: { id: true },
      });
      if (!user)
        throw new ApiError(
          404,
          "USER_NOT_FOUND",
          "Không tồn tại người dùng với email này.",
        );
      const existing = await tx.groupMember.findUnique({
        where: { userId_groupId: { userId: dto.userId, groupId } },
      });
      if (existing)
        throw new ApiError(
          409,
          "ALREADY_MEMBER",
          "Người dùng đã là thành viên của nhóm.",
        );
      const row = await tx.groupMember.create({
        data: { groupId, userId: dto.userId, role: dto.role },
        select: MEMBER_SELECT,
      });
      await this.changed(tx, groupId, dto.userId, dto.role);
      return { membership: membership(row) };
    });
  }

  update(
    actorId: string,
    groupId: string,
    userId: string,
    dto: ChangeMemberRoleDto,
  ) {
    return this.mutate(actorId, groupId, async (tx) => {
      await this.requireMutable(tx, groupId, userId);
      const row = await tx.groupMember.update({
        where: { userId_groupId: { userId, groupId } },
        data: { role: dto.role },
        select: MEMBER_SELECT,
      });
      await this.changed(tx, groupId, userId, dto.role);
      return { membership: membership(row) };
    });
  }

  async remove(actorId: string, groupId: string, userId: string) {
    await this.mutate(actorId, groupId, async (tx) => {
      await this.requireMutable(tx, groupId, userId);
      await tx.groupMember.delete({
        where: { userId_groupId: { userId, groupId } },
      });
      const [clock] = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      await revokeClassAccess(tx, userId, clock.now, { groupId });
      await this.changed(tx, groupId, userId, null);
    });
  }

  private mutate<T>(
    actorId: string,
    groupId: string,
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM groups WHERE id = ${groupId}::uuid FOR UPDATE`;
      await this.access.require(actorId, groupId, "canManageMembers", tx);
      return action(tx);
    });
  }

  private async requireMutable(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
  ) {
    const group = await tx.group.findUniqueOrThrow({
      where: { id: groupId },
      select: { ownerId: true },
    });
    const row = await tx.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId } },
    });
    if (group.ownerId === userId || row?.role === "OWNER")
      throw new ApiError(
        409,
        "OWNER_PROTECTED",
        "Không thể xóa hoặc đổi vai trò chủ nhóm.",
      );
    if (!row)
      throw new ApiError(
        404,
        "MEMBER_NOT_FOUND",
        "Thành viên không còn trong nhóm.",
      );
  }

  private async changed(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
    role: "HOST" | "VIEWER" | null,
  ) {
    // Serialize sequence allocation through commit so independent group transactions
    // cannot commit a lower version after a dispatcher has passed it.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(73003)::text`;
    await tx.membershipChange.create({
      data: { groupId, userId, role, removed: role === null },
    });
  }
}
