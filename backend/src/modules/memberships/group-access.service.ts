import { Injectable } from "@nestjs/common";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import type { Prisma } from "../../generated/prisma/client";
import type { GroupPermission, GroupPermissions } from "@streamora/contracts";

@Injectable()
export class GroupAccessService {
  constructor(private readonly prisma: PrismaService) {}

  // Always reads current DB state, including global role and disabled status.
  // Pass tx when authorizing a mutation under the group row lock.
  async require(
    userId: string,
    groupId: string,
    permission?: GroupPermission,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<GroupPermissions> {
    const [group, user] = await Promise.all([
      db.group.findFirst({
        where: { id: groupId, deletedAt: null },
        select: { ownerId: true },
      }),
      db.user.findUnique({
        where: { id: userId },
        select: { globalRole: true, disabledAt: true },
      }),
    ]);
    if (!user || user.disabledAt)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Tài khoản không được phép truy cập.",
      );
    if (!group)
      throw new ApiError(
        404,
        "GROUP_NOT_FOUND",
        "Nhóm không tồn tại hoặc đã bị xóa.",
      );
    const member = await db.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: { role: true },
    });
    const role =
      user.globalRole === "ADMIN"
        ? "ADMIN"
        : group.ownerId === userId
          ? "OWNER"
          : member?.role;
    // A stray OWNER membership cannot grant ownership over ownerId.
    if (!role || (role === "OWNER" && group.ownerId !== userId))
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn không phải thành viên của nhóm này.",
      );
    const permissions: GroupPermissions = {
      role,
      canManageMembers: role === "OWNER" || role === "ADMIN",
      canHost: role !== "VIEWER",
      canUpload: true,
      canViewRecordings: true,
    };
    if (permission && !permissions[permission])
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn không có quyền thực hiện thao tác này.",
      );
    return permissions;
  }

  async requireRoom(
    userId: string,
    roomId: string,
    permission?: GroupPermission,
  ) {
    const room = await this.prisma.groupRoom.findUnique({
      where: { id: roomId },
    });
    if (!room)
      throw new ApiError(404, "ROOM_NOT_FOUND", "Không tìm thấy phòng học.");
    await this.require(userId, room.groupId, permission);
    return room;
  }
}
