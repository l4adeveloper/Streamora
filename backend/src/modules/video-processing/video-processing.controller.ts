import {
  Body,
  Controller,
  Get,
  Head,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ApiBearerAuth,
  ApiExcludeController,
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
import { VideoProcessingService } from "./video-processing.service";
import { VideoDelivery } from "./video-delivery";
import { VideoStorage } from "./video-storage";
import { objectKey } from "./video-policy";
import { ApiError } from "../../common/api-error";
import { ApiErrors, ApiSuccess } from "../../documentation/api-decorators";
import {
  VideoProcessingResponseDto,
  VideoRetryResponseDto,
} from "./video-processing.models";

export class RetryVideoDto {}
@Controller("files/:fileId/processing")
@RequireAuth()
@ApiTags("Video processing")
@ApiBearerAuth("accessToken")
export class FileProcessingController {
  constructor(private readonly service: VideoProcessingService) {}
  @Get()
  @ApiSuccess(200, VideoProcessingResponseDto)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
  )
  @ApiOperation({ summary: "Trạng thái xử lý video trong thư viện" })
  processing(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
  ) {
    return this.service.processing(auth.user.id, fileId);
  }
  @Post("retry")
  @HttpCode(202)
  @ApiSuccess(202, VideoRetryResponseDto)
  @ApiErrors(
    [400, "IDEMPOTENCY_KEY_REQUIRED", "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
    [409, "JOB_NOT_RETRYABLE"],
  )
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Thử lại video FAILED; HOST/OWNER/ADMIN" })
  retry(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
    @Headers("idempotency-key") key: string,
    @Body() _body: RetryVideoDto,
  ) {
    return this.service.retry(auth.user.id, fileId, key);
  }
}
@Controller("recordings/:recordingId/processing")
@RequireAuth()
@ApiTags("Video processing")
@ApiBearerAuth("accessToken")
export class RecordingProcessingController {
  constructor(private readonly service: VideoProcessingService) {}
  @Get()
  @ApiOperation({ summary: "T13-01 — Trạng thái xử lý bản ghi" })
  @ApiSuccess(200, VideoProcessingResponseDto)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "RECORDING_NOT_FOUND"],
  )
  async processing(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("recordingId", UUIDParamPipe) recordingId: string,
  ) {
    return this.service.processing(
      auth.user.id,
      await this.service.recordingFile(recordingId),
    );
  }
  @Post("retry")
  @HttpCode(202)
  @ApiSuccess(202, VideoRetryResponseDto)
  @ApiErrors(
    [400, "IDEMPOTENCY_KEY_REQUIRED", "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "RECORDING_NOT_FOUND"],
    [409, "JOB_NOT_RETRYABLE"],
  )
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "T13-02 — Thử lại bản ghi FAILED" })
  async retry(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("recordingId", UUIDParamPipe) recordingId: string,
    @Headers("idempotency-key") key: string,
    @Body() _body: RetryVideoDto,
  ) {
    return this.service.retry(
      auth.user.id,
      await this.service.recordingFile(recordingId),
      key,
    );
  }
}
@Controller("video-media")
@ApiExcludeController()
export class VideoMediaController {
  constructor(
    private readonly delivery: VideoDelivery,
    private readonly storage: VideoStorage,
  ) {}
  @Head(":fileId/:jobId/*path")
  head(
    @Param("fileId", UUIDParamPipe) fileId: string,
    @Param("jobId", UUIDParamPipe) jobId: string,
    @Param("path") path: string[],
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.serve(fileId, jobId, path, req, res, true);
  }
  @Get(":fileId/:jobId/*path")
  get(
    @Param("fileId", UUIDParamPipe) fileId: string,
    @Param("jobId", UUIDParamPipe) jobId: string,
    @Param("path") path: string[],
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.serve(fileId, jobId, path, req, res);
  }
  private async serve(
    fileId: string,
    jobId: string,
    path: string[],
    req: Request,
    res: Response,
    head = false,
  ) {
    const grant = this.delivery.verify(req.cookies?.video_grant, fileId, jobId);
    const key =
      grant.prefix + "/" + (Array.isArray(path) ? path.join("/") : path);
    try {
      objectKey(key);
    } catch {
      throw new ApiError(403, "FORBIDDEN", "Đường dẫn video không hợp lệ.");
    }
    if (!/\.(m3u8|ts|m4s|mp4|aac|jpe?g)$/.test(key))
      throw new ApiError(403, "FORBIDDEN", "Đường dẫn video không hợp lệ.");
    const target = await this.storage.locations.resolve(grant.location);
    if (target.driver !== "local")
      throw new ApiError(404, "NOT_FOUND", "Không tìm thấy video local.");
    let file;
    try {
      file = await this.storage.open(
        grant.location,
        key,
        req.headers.range,
        head,
        grant.prefix,
      );
    } catch {
      throw new ApiError(404, "NOT_FOUND", "Không tìm thấy dữ liệu video.");
    }
    res.status(file.status).setHeader("Cache-Control", "private, no-store");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (file.contentRange) res.setHeader("Content-Range", file.contentRange);
    res.once("close", () => file.stream.destroy());
    const type = key.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : key.endsWith(".ts")
        ? "video/mp2t"
        : key.endsWith(".aac")
          ? "audio/aac"
          : /\.jpe?g$/.test(key)
            ? "image/jpeg"
            : "video/mp4";
    return new StreamableFile(file.stream, { type, length: file.size });
  }
}
