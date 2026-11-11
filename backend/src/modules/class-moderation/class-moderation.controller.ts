import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { IsBoolean, IsString, MaxLength, ValidateIf } from "class-validator";
import { PAGINATION_DEFAULTS } from "@streamora/contracts";
import type {
  ClassBanEntry,
  ClassBanRequest,
  ClassBanResponse,
  ClassMuteRequest,
  ClassMuteResponse,
} from "@streamora/contracts";
import {
  CurrentAuth,
  PaginationQueryDto,
  RequireAuth,
  UUIDParamPipe,
} from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { ClassModerationService } from "./class-moderation.service";

class ClassMuteDto implements ClassMuteRequest {
  @ApiPropertyOptional({
    description:
      "Omit for advisory mute, true to lock, false to unlock without unmuting.",
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  lock?: boolean;
}

class ClassBanDto implements ClassBanRequest {
  @ApiPropertyOptional({ maxLength: 500 })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class ClassMuteResultDto implements ClassMuteResponse {
  @ApiProperty({ format: "uuid" }) userId!: string;
  @ApiProperty({ enum: [true] }) muted!: true;
  @ApiProperty() locked!: boolean;
}

class ClassBanResultDto implements ClassBanResponse {
  @ApiProperty({ format: "uuid" }) userId!: string;
  @ApiProperty({ enum: [true] }) banned!: true;
}

class ClassBanEntryDto implements ClassBanEntry {
  @ApiProperty({ format: "uuid" }) userId!: string;
  @ApiPropertyOptional() fullName?: string;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ format: "date-time" }) bannedAt!: string;
}

class ClassBanListDto {
  @ApiProperty({ type: [ClassBanEntryDto] }) items!: ClassBanEntry[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

@ApiTags("Class moderation T07")
@ApiBearerAuth("accessToken")
@ApiResponse({ status: 400, description: "Dữ liệu hoặc con trỏ không hợp lệ" })
@ApiResponse({ status: 401, description: "Chưa đăng nhập" })
@ApiResponse({
  status: 403,
  description: "Yêu cầu quyền host, owner hoặc admin",
})
@RequireAuth()
@Controller("sessions/:sessionId")
export class ClassModerationController {
  constructor(private readonly moderation: ClassModerationService) {}

  @Post("participants/:userId/mute")
  @HttpCode(200)
  @ApiOperation({ summary: "Gửi yêu cầu tắt mic hoặc đổi quyền phát IVS" })
  @ApiOkResponse({ type: ClassMuteResultDto })
  @ApiResponse({
    status: 404,
    description: "Không tìm thấy buổi học hoặc người tham gia",
  })
  @ApiResponse({
    status: 409,
    description: "SESSION_NOT_LIVE hoặc TARGET_PROTECTED",
  })
  @ApiResponse({ status: 503, description: "MEDIA_REVOCATION_PENDING" })
  mute(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("userId", UUIDParamPipe) userId: string,
    @Body() dto: ClassMuteDto,
  ) {
    return this.moderation.mute(auth.user.id, sessionId, userId, dto.lock);
  }

  @Put("bans/:userId")
  @ApiOperation({ summary: "Chặn người tham gia khỏi buổi học" })
  @ApiOkResponse({ type: ClassBanResultDto })
  @ApiResponse({
    status: 404,
    description: "Không tìm thấy buổi học hoặc người tham gia",
  })
  @ApiResponse({ status: 409, description: "TARGET_PROTECTED" })
  @ApiResponse({ status: 503, description: "MEDIA_REVOCATION_PENDING" })
  ban(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("userId", UUIDParamPipe) userId: string,
    @Body() dto: ClassBanDto,
  ) {
    return this.moderation.ban(auth.user.id, sessionId, userId, dto.reason);
  }

  @Delete("bans/:userId")
  @HttpCode(204)
  @ApiOperation({ summary: "Gỡ chặn để người dùng có thể xin vào lại" })
  @ApiResponse({ status: 404, description: "SESSION_NOT_FOUND" })
  unban(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("userId", UUIDParamPipe) userId: string,
  ) {
    return this.moderation.unban(auth.user.id, sessionId, userId);
  }

  @Get("bans")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Xem danh sách chặn của buổi học" })
  @ApiOkResponse({ type: ClassBanListDto })
  @ApiResponse({ status: 404, description: "SESSION_NOT_FOUND" })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: {
      type: "integer",
      minimum: 1,
      maximum: PAGINATION_DEFAULTS.maxLimit,
      default: PAGINATION_DEFAULTS.limit,
    },
  })
  list(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.moderation.list(auth.user.id, sessionId, query);
  }
}
