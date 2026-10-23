import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  CurrentAuth,
  RequireAuth,
  UUIDParamPipe,
  type AuthenticatedIdentity,
} from "../../common";
import { ApiErrors, ApiSuccess } from "../../documentation/api-decorators";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { EmptySessionActionPipe } from "./class-sessions.dto";
import {
  ClassJoinRequestListQueryDto,
  DecideClassJoinDto,
  JOIN_REQUEST_STATUSES,
} from "./class-admissions.dto";
import { ClassAdmissionsService } from "./class-admissions.service";
import {
  ClassAdmissionResponseDto,
  ClassJoinRequestListResponseDto,
  ClassJoinRequestResponseDto,
  ClassParticipationListResponseDto,
  ClassParticipationResponseDto,
} from "./class-admissions.models";

const emptyBody = () =>
  ApiBody({
    required: false,
    schema: { type: "object", additionalProperties: false, maxProperties: 0 },
  });
const requiredKey = () =>
  ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "Khóa 1–128 ký tự ASCII không có khoảng trắng. Giữ nguyên khi retry cùng thao tác; dùng khóa mới khi chủ động xin/vào lại. Retry cũ không tạo yêu cầu hoặc lượt mới.",
  });

@Controller("sessions/:sessionId")
@ApiTags("T04 Admission")
@ApiBearerAuth("accessToken")
@RequireAuth()
@ApiParam({ name: "sessionId", format: "uuid" })
@ApiErrors(
  [400, "VALIDATION_ERROR", "INVALID_CURSOR"],
  [401, "UNAUTHENTICATED"],
  [
    403,
    "FORBIDDEN",
    "ADMISSION_REQUIRED",
    "ADMISSION_REVOKED",
    "USER_DISABLED",
  ],
  [
    404,
    "SESSION_NOT_FOUND",
    "GROUP_NOT_FOUND",
    "JOIN_REQUEST_NOT_FOUND",
    "PARTICIPATION_NOT_FOUND",
  ],
  [
    409,
    "SESSION_NOT_LIVE",
    "JOIN_REQUEST_NOT_REQUIRED",
    "JOIN_REQUEST_ALREADY_RESOLVED",
    "IDEMPOTENCY_CONFLICT",
  ],
)
export class ClassAdmissionsController {
  constructor(private readonly admission: ClassAdmissionsService) {}

  @Get("admission")
  @ApiOperation({
    summary: "T04 — Quyền và trạng thái tham gia của tôi",
    description:
      "Chỉ trạng thái của người gọi. Meet không cần membership; lớp yêu cầu thành viên hiện tại. Dùng khi refresh/reconnect. participation có thể là lượt cũ đã rời.",
  })
  @ApiSuccess(200, ClassAdmissionResponseDto)
  state(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
  ) {
    return this.admission.state(auth.user.id, id);
  }

  @Post("join-requests")
  @HttpCode(200)
  @ApiOperation({
    summary: "T04 — Xin vào phòng",
    description:
      "Chỉ khi LIVE. Cùng người chỉ có một PENDING/ACCEPTED còn hiệu lực. Người quản lý vào trực tiếp. Replay key trả trạng thái hiện tại của đúng yêu cầu cũ, không tạo lại sau reject/cancel/rời.",
  })
  @requiredKey()
  @emptyBody()
  @ApiSuccess(200, ClassJoinRequestResponseDto)
  request(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Body(new EmptySessionActionPipe()) _body: unknown,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.admission.requestJoin(auth.user.id, id, key);
  }

  @Get("join-requests")
  @ApiOperation({
    summary: "T04 — Hàng chờ/lịch sử theo trạng thái",
    description:
      "Chỉ người quản lý. PENDING mặc định; requestedAt ASC/id ASC. Không trả email hoặc thông tin đăng nhập.",
  })
  @ApiQuery({ name: "status", required: false, enum: JOIN_REQUEST_STATUSES })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiSuccess(200, ClassJoinRequestListResponseDto)
  queue(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Query() query: ClassJoinRequestListQueryDto,
  ) {
    return this.admission.listRequests(auth.user.id, id, query);
  }

  @Get("join-requests/:requestId")
  @ApiOperation({
    summary: "T04 — Đọc một yêu cầu",
    description:
      "Người gửi hoặc người quản lý, xác minh request thuộc đúng session.",
  })
  @ApiParam({ name: "requestId", format: "uuid" })
  @ApiSuccess(200, ClassJoinRequestResponseDto)
  findRequest(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Param("requestId", UUIDParamPipe) requestId: string,
  ) {
    return this.admission.findRequest(auth.user.id, id, requestId);
  }

  @Post("join-requests/:requestId/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "T04 — Hủy yêu cầu đang chờ của tôi",
    description:
      "Chỉ chính người gửi. CANCELLED lặp trả hiện trạng; không hủy được yêu cầu đã quyết định.",
  })
  @ApiParam({ name: "requestId", format: "uuid" })
  @emptyBody()
  @ApiSuccess(200, ClassJoinRequestResponseDto)
  cancel(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Param("requestId", UUIDParamPipe) requestId: string,
    @Body(new EmptySessionActionPipe()) _body: unknown,
  ) {
    return this.admission.cancelRequest(auth.user.id, id, requestId);
  }

  @Patch("join-requests/:requestId")
  @ApiOperation({
    summary: "T04 — Accept/reject",
    description:
      "Chỉ người quản lý, session LIVE, xác minh lại điều kiện người xin. Lặp cùng quyết định đang ACCEPTED/REJECTED giữ nguyên người/thời gian duyệt; quyết định ngược hoặc yêu cầu đã đóng trả 409.",
  })
  @ApiParam({ name: "requestId", format: "uuid" })
  @ApiSuccess(200, ClassJoinRequestResponseDto)
  decide(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Param("requestId", UUIDParamPipe) requestId: string,
    @Body() dto: DecideClassJoinDto,
  ) {
    return this.admission.decide(auth.user.id, id, requestId, dto);
  }

  @Post("enter")
  @HttpCode(200)
  @ApiOperation({
    summary: "T04 — Xác nhận thực sự vào phòng",
    description:
      "Chỉ LIVE; cần ACCEPTED trừ người quản lý. Nhiều tab/retry giữ một lượt đang mở. Không cấp token LiveKit. Replay key của lượt đã kết thúc bị từ chối.",
  })
  @requiredKey()
  @emptyBody()
  @ApiSuccess(200, ClassParticipationResponseDto)
  enter(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Body(new EmptySessionActionPipe()) _body: unknown,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.admission.enter(auth.user.id, id, key);
  }

  @Get("participants")
  @ApiOperation({
    summary: "T04 — Người đã vào và chưa rời",
    description:
      "Người quản lý hoặc người đang tham gia. joinedAt ASC/id ASC, chỉ tên và trạng thái tham gia. Chưa phải trạng thái kết nối Socket.IO; heartbeat ở mục realtime.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiSuccess(200, ClassParticipationListResponseDto)
  participants(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.admission.participants(auth.user.id, id, query);
  }

  @Post("participations/:participationId/leave")
  @HttpCode(200)
  @ApiOperation({
    summary: "T04 — Rời lượt tham gia của tôi",
    description:
      "Nhận đúng participationId để retry cũ không đóng lượt mới. Rời lặp giữ nguyên leftAt. Thành viên thường vào lại phải xin duyệt bằng thao tác mới.",
  })
  @ApiParam({ name: "participationId", format: "uuid" })
  @emptyBody()
  @ApiSuccess(200, ClassParticipationResponseDto)
  leave(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Param("participationId", UUIDParamPipe) participationId: string,
    @Body(new EmptySessionActionPipe()) _body: unknown,
  ) {
    return this.admission.leave(auth.user.id, id, participationId);
  }
}
