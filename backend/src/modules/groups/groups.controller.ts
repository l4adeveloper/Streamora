import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { RequireAuth, CurrentAuth, UUIDParamPipe } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { ApiErrors, ApiSuccess } from "../../documentation/api-decorators";
import { GroupsService } from "./groups.service";
import {
  CreateGroupDto,
  UpdateGroupDto,
  GroupListQueryDto,
} from "./groups.dto";
import { GroupResponseDto, GroupListResponseDto } from "./groups.models";

@Controller("groups")
@ApiTags("Groups")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  // ─── T02-01 Tạo group ─────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "T02-01 — Tạo group",
    description:
      "Tạo nhóm học tập mới; người tạo tự thành OWNER. Nhận Idempotency-Key để tránh tạo trùng. " +
      "Transaction bảo đảm group và membership OWNER cùng được tạo.",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description:
      "Khóa 1–128 ký tự ASCII không có khoảng trắng. Cùng user/key và nội dung trả lại kết quả cũ; khác nội dung trả 409.",
  })
  @ApiSuccess(201, GroupResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [409, "IDEMPOTENCY_CONFLICT", "GROUP_NAME_EXISTS"],
  )
  create(
    @CurrentAuth() identity: AuthenticatedIdentity,
    @Body() dto: CreateGroupDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.groups.create(identity.user.id, dto, idempotencyKey);
  }

  // ─── T02-02 Danh sách group ───────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: "T02-02 — Danh sách group của tôi",
    description:
      "Trả các group mà user hiện tại là thành viên (hoặc tất cả nếu ADMIN), sắp xếp theo createdAt giảm dần. " +
      "Hỗ trợ tìm theo tên và cursor pagination. Chỉ trả group chưa bị xóa mềm.",
  })
  @ApiSuccess(200, GroupListResponseDto)
  @ApiErrors([400, "INVALID_CURSOR"], [401, "UNAUTHENTICATED"])
  list(
    @CurrentAuth() identity: AuthenticatedIdentity,
    @Query() query: GroupListQueryDto,
  ) {
    const isAdmin = identity.user.globalRole === "ADMIN";
    return this.groups.list(identity.user.id, query, isAdmin);
  }

  // ─── T02-03 Chi tiết group ────────────────────────────────────────────────

  @Get(":groupId")
  @ApiOperation({
    summary: "T02-03 — Chi tiết group",
    description:
      "Chỉ thành viên của group (hoặc ADMIN) mới đọc được. Trả 404 nếu group không tồn tại, " +
      "đã xóa mềm; trả 403 nếu user không phải thành viên.",
  })
  @ApiParam({ name: "groupId", format: "uuid" })
  @ApiSuccess(200, GroupResponseDto)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND"],
  )
  findOne(
    @CurrentAuth() identity: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
  ) {
    const isAdmin = identity.user.globalRole === "ADMIN";
    return this.groups.findOne(identity.user.id, groupId, isAdmin);
  }

  // ─── T02-04 Sửa group ─────────────────────────────────────────────────────

  @Patch(":groupId")
  @ApiOperation({
    summary: "T02-04 — Sửa thông tin group",
    description:
      "Chỉ OWNER (hoặc ADMIN) mới được sửa. Không thể thay đổi ownerId qua endpoint này. " +
      "Truyền chỉ các trường cần cập nhật; bỏ trống trường giữ nguyên giá trị cũ.",
  })
  @ApiParam({ name: "groupId", format: "uuid" })
  @ApiSuccess(200, GroupResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND"],
    [409, "GROUP_NAME_EXISTS"],
  )
  update(
    @CurrentAuth() identity: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Body() dto: UpdateGroupDto,
  ) {
    const isAdmin = identity.user.globalRole === "ADMIN";
    return this.groups.update(identity.user.id, groupId, dto, isAdmin);
  }

  // ─── T02-05 Xóa mềm group ────────────────────────────────────────────────

  @Delete(":groupId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "T02-05 — Xóa mềm group",
    description:
      "Chỉ OWNER (hoặc ADMIN) mới được xóa. Dùng xóa mềm (deletedAt) để không mất liên kết dữ liệu nghiệp vụ. " +
      "Chặn xóa với lỗi ACTIVE_SESSION nếu có lớp đang LIVE. " +
      "Dọn dữ liệu/object qua policy nền; không cascade xóa bản ghi liên quan ngay lập tức.",
  })
  @ApiParam({ name: "groupId", format: "uuid" })
  @ApiSuccess(204)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND"],
    [409, "ACTIVE_SESSION"],
  )
  @HttpCode(204)
  async remove(
    @CurrentAuth() identity: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
  ): Promise<void> {
    const isAdmin = identity.user.globalRole === "ADMIN";
    await this.groups.remove(identity.user.id, groupId, isAdmin);
  }
}
