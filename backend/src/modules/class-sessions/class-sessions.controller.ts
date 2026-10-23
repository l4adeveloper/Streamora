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
  applyDecorators,
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
import { ClassSessionsService } from "./class-sessions.service";
import {
  ClassSessionListQueryDto,
  CreateGroupClassSessionDto,
  CreateMeetDto,
  EmptySessionActionPipe,
  SESSION_STATUSES,
  UpdateClassSessionDto,
} from "./class-sessions.dto";
import {
  ClassSessionListResponseDto,
  ClassSessionResponseDto,
  MeetPreviewResponseDto,
} from "./class-sessions.models";

const errors = () =>
  ApiErrors(
    [400, "VALIDATION_ERROR", "INVALID_CURSOR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN", "USER_DISABLED"],
    [404, "GROUP_NOT_FOUND", "SESSION_NOT_FOUND"],
    [
      409,
      "SESSION_NOT_EDITABLE",
      "INVALID_SESSION_STATE",
      "IDEMPOTENCY_CONFLICT",
    ],
  );
const idempotency = () =>
  ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description:
      "1–128 ký tự ASCII không có khoảng trắng. Cùng user/thao tác/key phải cùng nội dung và tài nguyên. Tạo lại trả response ban đầu; chuyển trạng thái luôn xác minh trạng thái hiện tại.",
  });
const pagination = () =>
  applyDecorators(
    ApiQuery({ name: "cursor", required: false, type: String }),
    ApiQuery({
      name: "limit",
      required: false,
      type: Number,
      minimum: 1,
      maximum: 100,
    }),
    ApiQuery({ name: "status", required: false, enum: SESSION_STATUSES }),
  );
const emptyBody = () =>
  ApiBody({
    required: false,
    schema: { type: "object", additionalProperties: false, maxProperties: 0 },
  });

@Controller("groups/:groupId/sessions")
@ApiTags("T04 Class Sessions")
@ApiBearerAuth("accessToken")
@RequireAuth()
@ApiParam({ name: "groupId", format: "uuid" })
@errors()
export class GroupClassSessionsController {
  constructor(private readonly sessions: ClassSessionsService) {}

  @Post()
  @ApiOperation({
    summary: "T04-01 — Tạo lịch học",
    description:
      "HOST/OWNER/ADMIN. Chỉ tạo SCHEDULED; không tạo room LiveKit. Không có Idempotency-Key thì mỗi POST là một lần tạo mới.",
  })
  @idempotency()
  @ApiSuccess(201, ClassSessionResponseDto)
  create(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Body() dto: CreateGroupClassSessionDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.sessions.createGroup(auth.user.id, groupId, dto, key);
  }

  @Get()
  @ApiOperation({
    summary: "T04-02 — Lịch học theo nhóm",
    description:
      "MEMBER/ADMIN. scheduledAt ASC, id ASC; cursor gắn với người gọi, nhóm và bộ lọc.",
  })
  @pagination()
  @ApiSuccess(200, ClassSessionListResponseDto)
  list(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Query() query: ClassSessionListQueryDto,
  ) {
    return this.sessions.listGroup(auth.user.id, groupId, query);
  }
}

@Controller("sessions/:sessionId")
@ApiTags("T04 Class Sessions")
@ApiBearerAuth("accessToken")
@RequireAuth()
@ApiParam({ name: "sessionId", format: "uuid" })
@errors()
export class ClassSessionsController {
  constructor(private readonly sessions: ClassSessionsService) {}

  @Get()
  @ApiOperation({
    summary: "T04-03 — Chi tiết buổi học",
    description:
      "Lớp: MEMBER/ADMIN. Meet: chủ phòng/ADMIN hoặc người đang tham gia. Dùng GET /meets/:code cho thông tin tối thiểu trước khi vào meet.",
  })
  @ApiSuccess(200, ClassSessionResponseDto)
  find(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
  ) {
    return this.sessions.find(auth.user.id, id);
  }

  @Patch()
  @ApiOperation({
    summary: "T04-04 — Sửa lịch/nội dung",
    description:
      "Chỉ người quản lý, chỉ khi SCHEDULED. Không đổi groupId/kind/người tạo. Body {} không thay đổi dữ liệu.",
  })
  @ApiSuccess(200, ClassSessionResponseDto)
  update(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Body() dto: UpdateClassSessionDto,
  ) {
    return this.sessions.update(auth.user.id, id, dto);
  }

  @Post("start")
  @HttpCode(200)
  @ApiOperation({
    summary: "T04-05 — Bắt đầu",
    description:
      "SCHEDULED→LIVE; LIVE trả hiện trạng; ENDED/CANCELLED không mở lại. Không tự ghi người quản lý vào phòng.",
  })
  @idempotency()
  @emptyBody()
  @ApiSuccess(200, ClassSessionResponseDto)
  start(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Body(new EmptySessionActionPipe()) _body: unknown,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.sessions.transition(auth.user.id, id, "START", key);
  }

  @Post("end")
  @HttpCode(200)
  @ApiOperation({
    summary: "T04-06 — Kết thúc",
    description:
      "LIVE→ENDED. Đóng yêu cầu/lượt tham gia và lưu một sự kiện session.ended.v1 trong cùng transaction. ENDED trả hiện trạng. Realtime báo kết thúc; consumer nội bộ có checkpoint để T11 tích hợp sau, chưa gọi ghi hình/LiveKit.",
  })
  @idempotency()
  @emptyBody()
  @ApiSuccess(200, ClassSessionResponseDto)
  end(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Body(new EmptySessionActionPipe()) _body: unknown,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.sessions.transition(auth.user.id, id, "END", key);
  }

  @Post("cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "T04 — Hủy buổi chưa bắt đầu",
    description:
      "SCHEDULED→CANCELLED. CANCELLED trả hiện trạng. LIVE/ENDED không hủy được.",
  })
  @idempotency()
  @emptyBody()
  @ApiSuccess(200, ClassSessionResponseDto)
  cancel(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("sessionId", UUIDParamPipe) id: string,
    @Body(new EmptySessionActionPipe()) _body: unknown,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.sessions.transition(auth.user.id, id, "CANCEL", key);
  }
}

@Controller("meets")
@ApiTags("T04 Independent Meets")
@ApiBearerAuth("accessToken")
@RequireAuth()
@errors()
export class MeetsController {
  constructor(private readonly sessions: ClassSessionsService) {}

  @Post()
  @ApiOperation({
    summary: "T04 — Tạo meet độc lập",
    description:
      "Người đăng nhập tạo phòng SCHEDULED, sau đó gọi start. Không tự tạo membership hay room LiveKit.",
  })
  @idempotency()
  @ApiSuccess(201, ClassSessionResponseDto)
  create(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Body() dto: CreateMeetDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.sessions.createMeet(auth.user.id, dto, key);
  }

  @Get()
  @ApiOperation({
    summary: "T04 — Meet do tôi tạo",
    description:
      "Chỉ các meet do người gọi tạo, kể cả ADMIN. createdAt DESC, id DESC. Không có danh sách công khai toàn hệ thống.",
  })
  @pagination()
  @ApiSuccess(200, ClassSessionListResponseDto)
  list(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Query() query: ClassSessionListQueryDto,
  ) {
    return this.sessions.listMine(auth.user.id, query);
  }

  @Get(":code")
  @ApiOperation({
    summary: "T04 — Thông tin tối thiểu theo mã meet",
    description:
      "Đã đăng nhập, có mã 12 ký tự A–Z/0–9. Không trả mô tả, lịch sử, hàng chờ hoặc danh sách người tham gia. Mã không cấp quyền vào.",
  })
  @ApiParam({
    name: "code",
    schema: { type: "string", pattern: "^[A-Z0-9]{12}$" },
  })
  @ApiSuccess(200, MeetPreviewResponseDto)
  preview(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("code") code: string,
  ) {
    return this.sessions.preview(auth.user.id, code);
  }
}
