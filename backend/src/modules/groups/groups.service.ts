import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { isUUID } from "class-validator";
import type { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { ApiError } from "../../common/api-error";
import type {
  Group,
  GroupResponse,
  GroupListResponse,
} from "@streamora/contracts";
import type {
  CreateGroupDto,
  UpdateGroupDto,
  GroupListQueryDto,
} from "./groups.dto";
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

function normalizeName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

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

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── T02-01: Tạo group ────────────────────────────────────────────────────

  async create(
    userId: string,
    dto: CreateGroupDto,
    idempotencyKey?: string,
  ): Promise<GroupResponse> {
    const name = normalizeName(dto.name);
    if (
      idempotencyKey !== undefined &&
      !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)
    ) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Idempotency-Key phải có từ 1 đến 128 ký tự ASCII không chứa khoảng trắng.",
      );
    }
    const bodyHash = createHash("sha256")
      .update(
        JSON.stringify({
          name,
          description: dto.description ?? null,
        }),
      )
      .digest("hex");

    return this.prisma.$transaction(async (tx) => {
      // Serialize creates/renames for the same owner, including requests without a key.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (idempotencyKey) {
        const previous = await tx.groupCreateRequest.findUnique({
          where: { userId_key: { userId, key: idempotencyKey } },
        });
        if (previous) {
          if (previous.bodyHash !== bodyHash) {
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Khóa tạo nhóm đã được dùng với nội dung khác.",
            );
          }
          return previous.response as unknown as GroupResponse;
        }
      }

      await this.requireAvailableName(tx, userId, name);

      // Create the group and its OWNER membership atomically.
      const g = await tx.group.create({
        data: {
          name,
          description: dto.description ?? null,
          ownerId: userId,
        },
        select: GROUP_SELECT,
      });
      await tx.groupMember.create({
        data: { userId, groupId: g.id, role: "OWNER" },
      });
      const response = { group: toGroupContract(g) };
      if (idempotencyKey) {
        await tx.groupCreateRequest.create({
          data: {
            userId,
            key: idempotencyKey,
            bodyHash,
            response: response as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return response;
    });
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
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const decoded = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString("utf8"),
        ) as { createdAt: string; id: string };
        if (
          !decoded ||
          typeof decoded.createdAt !== "string" ||
          typeof decoded.id !== "string" ||
          !isUUID(decoded.id) ||
          !Number.isFinite(Date.parse(decoded.createdAt)) ||
          new Date(decoded.createdAt).toISOString() !== decoded.createdAt
        )
          throw new Error();
        cursorCondition = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      } catch {
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "Con trỏ phân trang không hợp lệ.",
        );
      }
    }

    // ADMIN có thể truy vấn toàn hệ thống; người khác chỉ group đang là thành viên
    const membershipFilter = isAdmin
      ? {}
      : {
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        };

    const rows = await this.prisma.group.findMany({
      where: {
        deletedAt: null,
        ...membershipFilter,
        ...(query.q
          ? { name: { contains: query.q, mode: "insensitive" } }
          : {}),
        ...(cursorCondition
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { lt: cursorCondition.createdAt } },
                    {
                      createdAt: { equals: cursorCondition.createdAt },
                      id: { lt: cursorCondition.id },
                    },
                  ],
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
            JSON.stringify({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            }),
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
      throw new ApiError(
        404,
        "GROUP_NOT_FOUND",
        "Nhóm không tồn tại hoặc đã bị xóa.",
      );
    }

    if (!isAdmin && group.ownerId !== userId) {
      const membership = await this.prisma.groupMember.findUnique({
        where: { userId_groupId: { userId, groupId } },
        select: { role: true },
      });
      if (!membership) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Bạn không phải thành viên của nhóm này.",
        );
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
        throw new ApiError(
          404,
          "GROUP_NOT_FOUND",
          "Nhóm không tồn tại hoặc đã bị xóa.",
        );
      }
    }

    // Build only provided fields
    const data: { name?: string; description?: string | null } = {};
    if (dto.name !== undefined) data.name = normalizeName(dto.name);
    if (dto.description !== undefined) data.description = dto.description;

    if (Object.keys(data).length === 0) {
      return this.findOne(userId, groupId, isAdmin);
    }

    const group = await this.prisma.$transaction(async (tx) => {
      const current = await tx.group.findFirst({
        where: { id: groupId, deletedAt: null },
        select: { ownerId: true },
      });
      if (!current)
        throw new ApiError(404, "GROUP_NOT_FOUND", "Nhóm không tồn tại.");
      if (!isAdmin && current.ownerId !== userId)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Bạn không có quyền sửa nhóm này.",
        );

      await tx.$queryRaw`SELECT id FROM users WHERE id = ${current.ownerId}::uuid FOR UPDATE`;
      if (data.name !== undefined) {
        await this.requireAvailableName(
          tx,
          current.ownerId,
          data.name,
          groupId,
        );
      }
      return tx.group.update({
        where: { id: groupId, deletedAt: null, ownerId: current.ownerId },
        data,
        select: GROUP_SELECT,
      });
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
        throw new ApiError(
          404,
          "GROUP_NOT_FOUND",
          "Nhóm không tồn tại hoặc đã bị xóa.",
        );
      }
    }

    // T04 integration hook: check active sessions before deleting
    // (If session status == 'LIVE', throw 409 ACTIVE_SESSION)

    await this.prisma.group.update({
      where: {
        id: groupId,
        deletedAt: null,
        ...(!isAdmin ? { ownerId: userId } : {}),
      },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async requireAvailableName(
    tx: Prisma.TransactionClient,
    ownerId: string,
    name: string,
    excludeId: string | null = null,
  ) {
    // Normalize existing names too, without changing legacy data.
    const matches = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM groups
      WHERE owner_id = ${ownerId}::uuid AND deleted_at IS NULL
        AND (${excludeId}::uuid IS NULL OR id <> ${excludeId}::uuid)
        AND lower(btrim(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) = lower(${name})
      LIMIT 1
    `;
    if (matches.length) {
      throw new ApiError(
        409,
        "GROUP_NAME_EXISTS",
        "Bạn đã có nhóm mang tên này. Vui lòng chọn tên khác.",
      );
    }
  }

  /** Check membership and return the member's role; throws 404/403 accordingly. */
  async requireRole(
    userId: string,
    groupId: string,
    allowedRoles: Array<"OWNER" | "HOST" | "VIEWER">,
  ): Promise<void> {
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, deletedAt: null },
      select: { id: true, ownerId: true },
    });
    if (!group)
      throw new ApiError(404, "GROUP_NOT_FOUND", "Nhóm không tồn tại.");

    // ownerId is the source of truth used by both the API and the UI.
    if (group.ownerId === userId && allowedRoles.includes("OWNER")) return;

    const member = await this.prisma.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: { role: true },
    });
    if (!member)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn không phải thành viên của nhóm này.",
      );
    if (member.role === "OWNER" || !allowedRoles.includes(member.role))
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn không có quyền thực hiện thao tác này.",
      );
  }
}
