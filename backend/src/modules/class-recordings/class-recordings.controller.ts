import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentAuth, RequireAuth, UUIDParamPipe } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import {
  ClassRecordingResponseDto,
  ClassRecordingStateDto,
  CompleteClassRecordingDto,
  StartClassRecordingDto,
  UpdateClassRecordingLayoutDto,
} from "./class-recordings.dto";
import { ClassRecordingsService } from "./class-recordings.service";

@ApiTags("Class recordings")
@ApiBearerAuth("accessToken")
@ApiResponse({ status: 401, description: "Chưa đăng nhập" })
@ApiResponse({ status: 403, description: "Không có quyền" })
@ApiResponse({ status: 404, description: "Không tìm thấy buổi học hoặc bản ghi" })
@RequireAuth()
@Controller("sessions/:sessionId")
export class ClassRecordingsController {
  constructor(private readonly recordings: ClassRecordingsService) {}

  @Get("recording")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: ClassRecordingStateDto })
  @ApiOperation({ summary: "Trạng thái ghi hình hiện tại và người đang trình bày" })
  state(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
  ) {
    return this.recordings.state(auth.user.id, sessionId);
  }

  @Post("recordings")
  @HttpCode(200)
  @ApiOkResponse({ type: ClassRecordingResponseDto })
  @ApiResponse({
    status: 409,
    description: "SESSION_NOT_LIVE, RECORDING_ACTIVE, RECORDING_REQUIRES_GROUP",
  })
  @ApiOperation({
    summary: "Host, owner hoặc admin bắt đầu ghi hình",
    description:
      "Chỉ giữ người chia sẻ màn hình đầu tiên; các chia sẻ khác bị ngắt. Lặp lại từ cùng người ghi trả bản ghi hiện tại.",
  })
  start(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Body() dto: StartClassRecordingDto,
  ) {
    return this.recordings.start(auth.user.id, sessionId, dto.participationId);
  }

  @Patch("recordings/:recordingId/layout")
  @ApiOkResponse({ type: ClassRecordingResponseDto })
  @ApiOperation({ summary: "Người trình bày đổi góc hoặc ẩn camera trong bản ghi" })
  layout(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("recordingId", UUIDParamPipe) recordingId: string,
    @Body() dto: UpdateClassRecordingLayoutDto,
  ) {
    return this.recordings.layout(auth.user.id, sessionId, recordingId, dto);
  }

  @Post("recordings/:recordingId/heartbeat")
  @HttpCode(200)
  @ApiOperation({ summary: "Người ghi báo bản ghi vẫn đang chạy" })
  heartbeat(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("recordingId", UUIDParamPipe) recordingId: string,
  ) {
    return this.recordings.heartbeat(auth.user.id, sessionId, recordingId);
  }

  @Post("recordings/:recordingId/stop")
  @HttpCode(200)
  @ApiOkResponse({ type: ClassRecordingResponseDto })
  @ApiOperation({ summary: "Dừng ghi; người ghi tải file lên rồi gọi complete" })
  stop(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("recordingId", UUIDParamPipe) recordingId: string,
  ) {
    return this.recordings.stop(auth.user.id, sessionId, recordingId);
  }

  @Post("recordings/:recordingId/complete")
  @HttpCode(200)
  @ApiOkResponse({ type: ClassRecordingResponseDto })
  @ApiOperation({ summary: "Liên kết file đã tải lên vào bản ghi buổi học" })
  complete(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("recordingId", UUIDParamPipe) recordingId: string,
    @Body() dto: CompleteClassRecordingDto,
  ) {
    return this.recordings.complete(auth.user.id, sessionId, recordingId, dto.fileId);
  }

  @Post("recordings/:recordingId/fail")
  @HttpCode(200)
  @ApiOkResponse({ type: ClassRecordingResponseDto })
  @ApiOperation({ summary: "Người ghi báo không lưu được bản ghi" })
  fail(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Param("recordingId", UUIDParamPipe) recordingId: string,
  ) {
    return this.recordings.fail(auth.user.id, sessionId, recordingId);
  }
}
