import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
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
