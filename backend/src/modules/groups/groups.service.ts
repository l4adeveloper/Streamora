import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { ApiError } from "../../common/api-error";
import type { Group, GroupResponse, GroupListResponse } from "@streamora/contracts";
import type { CreateGroupDto, UpdateGroupDto, GroupListQueryDto } from "./groups.dto";
import { PAGINATION_DEFAULTS } from "@streamora/contracts";

// Shape returned from Prisma — maps to Group contract
const GROUP_SELECT = {
  id: true,
  name: true,
  description: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toGroupContract(raw: {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}): Group {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    ownerId: raw.ownerId,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

interface IdempotencyEntry {
  userId: string;
  response: GroupResponse;
  expiresAt: number;
}

@Injectable()
export class GroupsService {
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();

  constructor(private readonly prisma: PrismaService) {}

  // ─── T02-01: Tạo group ────────────────────────────────────────────────────

  async create(
    userId: string,
    dto: CreateGroupDto,
    idempotencyKey?: string,
  ): Promise<GroupResponse> {
    // Check idempotency cache if key provided
    if (idempotencyKey) {
      const cacheKey = `${userId}:${idempotencyKey}`;
      const cached = this.idempotencyCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
      }
    }

    // Transaction: tạo group và gán membership OWNER cùng lúc
    const group = await this.prisma.$transaction(async (tx) => {
      const g = await tx.group.create({
        data: {
          name: dto.name,
          description: dto.description ?? null,
          ownerId: userId,
        },
        select: GROUP_SELECT,
      });
      await tx.groupMember.create({
        data: { userId, groupId: g.id, role: "OWNER" },
      });
      return g;
    });

    const response = { group: toGroupContract(group) };

    if (idempotencyKey) {
      const cacheKey = `${userId}:${idempotencyKey}`;
      this.idempotencyCache.set(cacheKey, {
        userId,
        response,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes TTL
      });
    }

    return response;
  }

  // ─── T02-02: Danh sách group của user (hoặc toàn hệ thống nếu ADMIN) ─────

  async list(
    userId: string,
    query: GroupListQueryDto,
    isAdmin = false,
  ): Promise<GroupListResponse> {
    const limit = Math.min(
      query.limit ?? PAGINATION_DEFAULTS.limit,
      PAGINATION_DEFAULTS.maxLimit,
    );

    // Decode opaque cursor (base64-encoded ISO date + UUID)
    let cursorCondition: { createdAt: Date; id: string } | undefined;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString("utf8"),
        ) as { createdAt: string; id: string };
        cursorCondition = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      } catch {
        throw new ApiError(400, "INVALID_CURSOR", "Con trỏ phân trang không hợp lệ.");
      }
    }

    // ADMIN có thể truy vấn toàn hệ thống; người khác chỉ group đang là thành viên
    const membershipFilter = isAdmin ? {} : { members: { some: { userId } } };

    const rows = await this.prisma.group.findMany({
      where: {
        deletedAt: null,
        ...membershipFilter,
        ...(query.q
          ? { name: { contains: query.q, mode: "insensitive" } }
          : {}),
        ...(cursorCondition
          ? {
              OR: [
                { createdAt: { lt: cursorCondition.createdAt } },
                {
                  createdAt: { equals: cursorCondition.createdAt },
                  id: { lt: cursorCondition.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: GROUP_SELECT,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
          ).toString("base64url")
        : null;

    return { items: items.map(toGroupContract), nextCursor };
  }

  // ─── T02-03: Chi tiết group ──────────────────────────────────────────────

  async findOne(
    userId: string,
    groupId: string,
    isAdmin = false,
  ): Promise<GroupResponse> {
    const group = await this.prisma.group.findFirst({
      where: {
        id: groupId,
        deletedAt: null,
      },
      select: GROUP_SELECT,
    });
    if (!group) {
      throw new ApiError(404, "GROUP_NOT_FOUND", "Nhóm không tồn tại hoặc đã bị xóa.");
    }

    if (!isAdmin) {
      const membership = await this.prisma.groupMember.findUnique({
        where: { userId_groupId: { userId, groupId } },
        select: { role: true },
      });
      if (!membership) {
        throw new ApiError(403, "FORBIDDEN", "Bạn không phải thành viên của nhóm này.");
      }
    }

    return { group: toGroupContract(group) };
  }

  // ─── T02-04: Sửa group ───────────────────────────────────────────────────

  async update(
    userId: string,
    groupId: string,
    dto: UpdateGroupDto,
    isAdmin = false,
  ): Promise<GroupResponse> {
    if (!isAdmin) {
      await this.requireRole(userId, groupId, ["OWNER"]);
    } else {
      const exists = await this.prisma.group.findFirst({
        where: { id: groupId, deletedAt: null },
        select: { id: true },
      });
      if (!exists) {
        throw new ApiError(404, "GROUP_NOT_FOUND", "Nhóm không tồn tại hoặc đã bị xóa.");
      }
    }

    // Build only provided fields
    const data: { name?: string; description?: string | null } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;

    if (Object.keys(data).length === 0) {
      return this.findOne(userId, groupId, isAdmin);
    }

    const group = await this.prisma.group.update({
      where: { id: groupId, deletedAt: null },
      data,
      select: GROUP_SELECT,
    });
    return { group: toGroupContract(group) };
  }

  // ─── T02-05: Xóa mềm group ───────────────────────────────────────────────

  async remove(
    userId: string,
    groupId: string,
    isAdmin = false,
  ): Promise<void> {
    if (!isAdmin) {
      await this.requireRole(userId, groupId, ["OWNER"]);
    } else {
      const exists = await this.prisma.group.findFirst({
        where: { id: groupId, deletedAt: null },
        select: { id: true },
      });
      if (!exists) {
        throw new ApiError(404, "GROUP_NOT_FOUND", "Nhóm không tồn tại hoặc đã bị xóa.");
      }
    }

    // T04 integration hook: check active sessions before deleting
    // (If session status == 'LIVE', throw 409 ACTIVE_SESSION)

    await this.prisma.group.update({
      where: { id: groupId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Check membership and return the member's role; throws 404/403 accordingly. */
  async requireRole(
    userId: string,
    groupId: string,
    allowedRoles: Array<"OWNER" | "HOST" | "VIEWER">,
  ): Promise<void> {
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, deletedAt: null },
      select: { id: true },
    });
    if (!group)
      throw new ApiError(404, "GROUP_NOT_FOUND", "Nhóm không tồn tại.");

    const member = await this.prisma.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: { role: true },
    });
    if (!member)
      throw new ApiError(403, "FORBIDDEN", "Bạn không phải thành viên của nhóm này.");
    if (!allowedRoles.includes(member.role as "OWNER" | "HOST" | "VIEWER"))
      throw new ApiError(403, "FORBIDDEN", "Bạn không có quyền thực hiện thao tác này.");
  }
}
