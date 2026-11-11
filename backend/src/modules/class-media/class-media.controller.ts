import {
  Body,
  Controller,
  Param,
  Post,
  HttpCode,
  Header,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiOkResponse,
} from "@nestjs/swagger";
import { CurrentAuth, RequireAuth, UUIDParamPipe } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { ClassMediaService } from "./class-media.service";
import {
  ClassMediaHeartbeatDto,
  JoinClassMediaDto,
  JoinClassMediaResponseDto,
  ClassMediaAckDto,
  ClassMediaLeaveDto,
} from "./class-media.dto";

@ApiTags("Class media T05")
@ApiBearerAuth("accessToken")
@RequireAuth()
@Controller("sessions/:sessionId")
export class ClassMediaController {
  constructor(private readonly media: ClassMediaService) {}
  @Post("join")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: JoinClassMediaResponseDto })
  @ApiOperation({
    summary: "Cấp token IVS cho mic/camera hoặc chia sẻ màn hình",
    description:
      "clientId theo tab; requestId giữ nguyên khi retry. Không nhận userId/role/stageArn từ client.",
  })
  join(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Body() dto: JoinClassMediaDto,
  ) {
    return this.media.join(
      { userId: auth.user.id, authSessionId: auth.sessionId },
      sessionId,
      dto,
    );
  }
  @Post("media/:connectionId/heartbeat")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: ClassMediaAckDto })
  @ApiOperation({
    summary: "T05 — Gia hạn kết nối media và báo trạng thái thiết bị",
  })
  heartbeat(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("connectionId", UUIDParamPipe) id: string,
    @Body() dto: ClassMediaHeartbeatDto,
  ) {
    return this.media.heartbeat(
      { userId: auth.user.id, authSessionId: auth.sessionId },
      sessionId,
      id,
      dto,
    );
  }
  @Post("media/:connectionId/leave")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: ClassMediaAckDto })
  @ApiOperation({ summary: "T05 — Đóng kết nối media của phiên hiện tại" })
  leave(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("connectionId", UUIDParamPipe) id: string,
    @Body() dto: ClassMediaLeaveDto,
  ) {
    return this.media.leave(
      { userId: auth.user.id, authSessionId: auth.sessionId },
      sessionId,
      id,
      dto.requestId,
    );
  }
}
