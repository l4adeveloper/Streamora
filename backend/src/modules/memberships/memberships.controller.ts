import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentAuth, RequireAuth, UUIDParamPipe } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { ApiErrors, ApiSuccess } from "../../documentation/api-decorators";
import { GroupAccessService } from "./group-access.service";
import { MembershipsService } from "./memberships.service";
import {
  AddMemberDto,
  ChangeMemberRoleDto,
  MemberListQueryDto,
  UserLookupQueryDto,
} from "./memberships.dto";
import {
  GroupPermissionsDto,
  MembershipListResponseDto,
  MembershipResponseDto,
  UserLookupResponseDto,
} from "./memberships.models";

@Controller("users")
@ApiTags("Memberships")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class MembershipLookupController {
  constructor(private readonly members: MembershipsService) {}
  @Get("lookup")
  @ApiOperation({
    summary: "T03-01 — Tìm tài khoản bằng email chính xác",
    description:
      "Chỉ OWNER/ADMIN của group; tối đa 30 lần/phút/user trên mọi instance.",
  })
  @ApiSuccess(200, UserLookupResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND"],
    [429, "RATE_LIMITED"],
  )
  lookup(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Query() query: UserLookupQueryDto,
  ) {
    return this.members.lookup(auth.user.id, query);
  }
}

@Controller("groups/:groupId")
@ApiTags("Memberships")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class MembershipsController {
  constructor(
    private readonly members: MembershipsService,
    private readonly access: GroupAccessService,
  ) {}
  @Get("members")
  @ApiOperation({
    summary: "T03-02 — Danh sách thành viên",
    description:
      "MEMBER/ADMIN. Tìm tên/email, phân trang joinedAt + userId. Email hiển thị cho thành viên theo yêu cầu T03.",
  })
  @ApiSuccess(200, MembershipListResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR", "INVALID_CURSOR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND"],
  )
  list(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Query() query: MemberListQueryDto,
  ) {
    return this.members.list(auth.user.id, groupId, query);
  }
  @Post("members")
  @ApiOperation({ summary: "T03-03 — Thêm thành viên HOST/VIEWER" })
  @ApiSuccess(201, MembershipResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND", "USER_NOT_FOUND"],
    [409, "ALREADY_MEMBER"],
  )
  add(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.members.add(auth.user.id, groupId, dto);
  }
  @Patch("members/:userId")
  @ApiOperation({ summary: "T03-04 — Đổi vai trò HOST/VIEWER" })
  @ApiSuccess(200, MembershipResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND", "MEMBER_NOT_FOUND"],
    [409, "OWNER_PROTECTED"],
  )
  update(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Param("userId", UUIDParamPipe) userId: string,
    @Body() dto: ChangeMemberRoleDto,
  ) {
    return this.members.update(auth.user.id, groupId, userId, dto);
  }
  @Delete("members/:userId")
  @HttpCode(204)
  @ApiOperation({
    summary: "T03-05 — Xóa thành viên, thu hồi truy cập",
    description:
      "Commit quyền trước; transactional outbox đồng bộ Socket.IO và LiveKit, retry khi media lỗi.",
  })
  @ApiSuccess(204)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND", "MEMBER_NOT_FOUND"],
    [409, "OWNER_PROTECTED"],
  )
  remove(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Param("userId", UUIDParamPipe) userId: string,
  ) {
    return this.members.remove(auth.user.id, groupId, userId);
  }
  @Get("permissions/me")
  @ApiOperation({
    summary: "T03-06 — Quyền hiệu lực của tôi",
    description: "Quyền UI; từng API vẫn đọc quyền hiện hành từ DB.",
  })
  @ApiSuccess(200, GroupPermissionsDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND"],
  )
  permissions(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
  ) {
    return this.access.require(auth.user.id, groupId);
  }
}
