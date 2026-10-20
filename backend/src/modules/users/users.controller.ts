import { Body, Controller, Get, Patch } from "@nestjs/common";
import {
  RequireAuth,
  CurrentAuth,
  type AuthenticatedIdentity,
} from "../../common";
import type { UserResponse } from "@streamora/contracts";
import { UpdateProfileDto } from "./profile.dto";
import { UsersService } from "./users.service";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiErrors, ApiSuccess } from "../../documentation/api-decorators";
import { UserResponseDto } from "../../documentation/api-models";

@Controller("users")
@ApiTags("Users")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get("me")
  @ApiOperation({
    summary: "T01-05 — Xem tài khoản của tôi",
    description:
      "Cần Bearer, refresh cookie không đủ. Guard kiểm tra session và trạng thái user trong DB.",
  })
  @ApiSuccess(200, UserResponseDto)
  @ApiErrors([401, "UNAUTHENTICATED"], [403, "USER_DISABLED"])
  me(@CurrentAuth() identity: AuthenticatedIdentity): UserResponse {
    return { user: identity.user };
  }

  @Patch("me")
  @ApiOperation({
    summary: "T01-06 — Sửa họ tên",
    description:
      "Chỉ nhận fullName; từ chối email, password, globalRole và trường bổ sung. Cần Bearer còn phiên hợp lệ.",
  })
  @ApiSuccess(200, UserResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "USER_DISABLED"],
  )
  async update(
    @CurrentAuth() identity: AuthenticatedIdentity,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserResponse> {
    return {
      user: await this.users.updateFullName(identity.user.id, dto.fullName),
    };
  }
}
