import {
  Body,
  Controller,
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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { PAGINATION_DEFAULTS } from "@streamora/contracts";
import {
  CurrentAuth,
  PaginationQueryDto,
  RequireAuth,
  UUIDParamPipe,
  type AuthenticatedIdentity,
} from "../../common";
import {
  ClosePollDto,
  CreatePollDto,
  PollListDto,
  PollResponseDto,
  VotePollDto,
} from "./polls.dto";
import { PollsService } from "./polls.service";

@ApiTags("Polls T09")
@ApiBearerAuth("accessToken")
@ApiResponse({ status: 400, description: "Dữ liệu không hợp lệ" })
@ApiResponse({ status: 401, description: "Chưa đăng nhập" })
@ApiResponse({
  status: 403,
  description: "Không có quyền truy cập hoặc đã bị chặn",
})
@ApiResponse({
  status: 404,
  description: "Không tìm thấy buổi học hoặc bình chọn",
})
@RequireAuth()
@Controller()
export class PollsController {
  constructor(private readonly polls: PollsService) {}

  @Post("sessions/:sessionId/polls")
  @ApiOperation({ summary: "Host, owner hoặc admin tạo và mở bình chọn" })
  @ApiCreatedResponse({ type: PollResponseDto })
  @ApiResponse({ status: 409, description: "SESSION_NOT_LIVE" })
  create(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) sessionId: string,
    @Body() body: CreatePollDto,
  ) {
    return this.polls.create(auth.user.id, sessionId, body);
  }

  @Get("sessions/:sessionId/polls")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Khôi phục bình chọn, kết quả và lựa chọn của chính mình",
  })
  @ApiOkResponse({ type: PollListDto })
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
    return this.polls.list(auth.user.id, sessionId, query);
  }

  @Put("polls/:pollId/vote")
  @ApiOperation({ summary: "Bỏ hoặc đổi phiếu trong bình chọn đang mở" })
  @ApiOkResponse({ type: PollResponseDto })
  @ApiResponse({
    status: 400,
    description: "Dữ liệu không hợp lệ hoặc OPTION_NOT_IN_POLL",
  })
  @ApiResponse({ status: 409, description: "POLL_CLOSED" })
  vote(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("pollId", UUIDParamPipe) pollId: string,
    @Body() body: VotePollDto,
  ) {
    return this.polls.vote(auth.user.id, pollId, body.optionId);
  }

  @Post("polls/:pollId/close")
  @HttpCode(200)
  @ApiOperation({ summary: "Host, owner hoặc admin đóng bình chọn" })
  @ApiOkResponse({ type: PollResponseDto })
  close(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("pollId", UUIDParamPipe) pollId: string,
    @Body() _body: ClosePollDto,
  ) {
    return this.polls.close(auth.user.id, pollId);
  }
}
