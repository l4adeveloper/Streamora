import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiOkResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  CurrentAuth,
  RequireAuth,
  UUIDParamPipe,
  type AuthenticatedIdentity,
} from "../../common";
import { ApiError } from "../../common/api-error";
import { UploadsService } from "./uploads.service";
import {
  CreateUploadDto,
  SignPartsDto,
  CompleteUploadDto,
} from "./uploads.dto";

@Controller("uploads")
@ApiTags("Uploads")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}
  @Get(":uploadId")
  @ApiOkResponse({
    schema: {
      type: "object",
      required: [
        "uploadId",
        "status",
        "filename",
        "size",
        "fingerprint",
        "partSize",
        "totalParts",
        "expiresAt",
        "uploadedParts",
      ],
      properties: {
        uploadId: { type: "string", format: "uuid" },
        status: {
          type: "string",
          enum: [
            "INITIALIZING",
            "ACTIVE",
            "COMPLETING",
            "COMPLETED",
            "ABORTING",
            "ABORTED",
          ],
        },
        groupId: { type: "string", format: "uuid" },
        filename: { type: "string" },
        size: { type: "integer" },
        fingerprint: { type: "string" },
        partSize: { type: "integer" },
        totalParts: { type: "integer" },
        expiresAt: { type: "string", format: "date-time" },
        fileId: { type: "string", format: "uuid" },
        objectReady: { type: "boolean" },
        uploadedParts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              partNumber: { type: "integer" },
              etag: { type: "string" },
              size: { type: "integer" },
            },
          },
        },
      },
    },
  })
  @ApiOperation({
    summary: "T17-01 — Trạng thái và parts thực tế để tiếp tục tải lên",
  })
  status(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("uploadId", UUIDParamPipe) id: string,
  ) {
    return this.uploads.status(auth.user.id, id);
  }
  @Post()
  @ApiOperation({ summary: "T16-01 — Tạo phiên multipart" })
  create(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Body() dto: CreateUploadDto,
  ) {
    return this.uploads.create(auth.user.id, dto);
  }
  @Post(":uploadId/parts/sign")
  @HttpCode(200)
  @ApiOperation({
    summary: "T16-02 — Ký tối đa 8 part, URL có hiệu lực tối đa 60 giây",
  })
  sign(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("uploadId", UUIDParamPipe) id: string,
    @Body() dto: SignPartsDto,
  ) {
    return this.uploads.sign(auth.user.id, id, dto.partNumbers);
  }
  @Post(":uploadId/complete")
  @HttpCode(200)
  @ApiOperation({
    summary: "T16-03 — Xác minh và hoàn tất; retry trả cùng fileId",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  complete(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("uploadId", UUIDParamPipe) id: string,
    @Body() dto: CompleteUploadDto,
    @Headers("idempotency-key") key?: string,
  ) {
    if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key))
      throw new ApiError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Cần Idempotency-Key hợp lệ.",
      );
    // Upload ID is the durable idempotency scope; any retry returns its single file.
    return this.uploads.complete(auth.user.id, id, dto);
  }
  @Delete(":uploadId")
  @HttpCode(204)
  @ApiOperation({
    summary: "T16-04 — Hủy phiên và dọn multipart; có thể gọi lại",
  })
  abort(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("uploadId", UUIDParamPipe) id: string,
  ) {
    return this.uploads.abort(auth.user.id, id);
  }
}
