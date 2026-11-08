import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiExcludeEndpoint,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentAuth, RequireAuth, UUIDParamPipe } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { ApiErrors, ApiSuccess } from "../../documentation/api-decorators";
import { FilesService } from "./files.service";
import {
  FileListQueryDto,
  LegacyFileListQueryDto,
  RenameFileDto,
} from "./files.dto";
import {
  FileDownloadResponseDto,
  FileListResponseDto,
  FileResponseDto,
  VideoPlaybackResponseDto,
} from "./files.models";

@Controller("groups/:groupId/files")
@ApiTags("Files")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class GroupFilesController {
  constructor(private readonly files: FilesService) {}
  @Get()
  @ApiOperation({
    summary: "T15-01 — Danh sách và tìm tên tài liệu trong nhóm",
  })
  @ApiParam({ name: "groupId", format: "uuid" })
  @ApiSuccess(200, FileListResponseDto)
  @ApiErrors(
    [400, "INVALID_CURSOR", "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND"],
  )
  list(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Query() query: FileListQueryDto,
  ) {
    return this.files.list(auth.user.id, groupId, query);
  }
}
@Controller("files")
@ApiTags("Files")
@ApiBearerAuth("accessToken")
@RequireAuth()
@ApiParam({ name: "fileId", format: "uuid" })
export class FilesController {
  constructor(private readonly files: FilesService) {}
  @Post(":fileId/playback")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Video preview — nguồn gốc và các chất lượng đã được xuất bản; chuẩn bị T13",
  })
  @ApiSuccess(200, VideoPlaybackResponseDto)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
    [409, "FILE_NOT_READY"],
    [415, "VIDEO_PREVIEW_UNSUPPORTED"],
    [503, "VIDEO_OUTPUT_INVALID", "STORAGE_UNAVAILABLE"],
  )
  playback(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
  ) {
    return this.files.playback(auth.user.id, fileId);
  }
  @Get()
  @ApiExcludeEndpoint()
  legacyList(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Query() query: LegacyFileListQueryDto,
  ) {
    return this.files.list(auth.user.id, query.groupId, query);
  }
  @Get(":fileId")
  @ApiOperation({ summary: "T15-02 — Chi tiết tài liệu" })
  @ApiSuccess(200, FileResponseDto)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
  )
  detail(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
  ) {
    return this.files.detail(auth.user.id, fileId);
  }
  @Patch(":fileId")
  @ApiOperation({ summary: "T15-03 — Đổi tên hiển thị; object key giữ nguyên" })
  @ApiSuccess(200, FileResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
  )
  rename(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
    @Body() dto: RenameFileDto,
  ) {
    return this.files.rename(auth.user.id, fileId, dto.name);
  }
  @Delete(":fileId")
  @HttpCode(204)
  @ApiOperation({
    summary: "T15-04 — Xóa mềm và lên lịch dọn object",
    description:
      "Chặn file PENDING, liên kết recording hoặc còn file_usages. URL đã cấp còn hiệu lực tối đa TTL.",
  })
  @ApiSuccess(204)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
    [409, "FILE_IN_USE"],
  )
  remove(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
  ) {
    return this.files.remove(auth.user.id, fileId);
  }
  @Post(":fileId/download-url")
  @HttpCode(200)
  @ApiOperation({ summary: "T15-05 — Cấp URL tải ngắn hạn có kiểm tra quyền" })
  @ApiSuccess(200, FileDownloadResponseDto)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
    [409, "FILE_NOT_READY"],
    [503, "STORAGE_UNAVAILABLE"],
  )
  download(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
  ) {
    return this.files.download(auth.user.id, fileId);
  }
  @Post(":fileId/preview-url")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Xem trước PDF/ảnh/video — URL inline ngắn hạn, kiểm tra quyền và trạng thái",
  })
  @ApiSuccess(200, FileDownloadResponseDto)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
    [409, "FILE_NOT_READY"],
    [415, "PDF_PREVIEW_UNSUPPORTED"],
    [503, "STORAGE_UNAVAILABLE"],
  )
  preview(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
  ) {
    return this.files.download(auth.user.id, fileId, true);
  }
}
