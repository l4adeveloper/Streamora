import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiExcludeEndpoint,
  ApiParam,
  ApiTags,
  ApiProduces,
  ApiResponse,
} from "@nestjs/swagger";
import { CurrentAuth, RequireAuth, UUIDParamPipe } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { ApiErrors, ApiSuccess } from "../../documentation/api-decorators";
import { FilesService } from "./files.service";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import {
  CreateFolderDto,
  FileListQueryDto,
  LegacyFileListQueryDto,
  ListFoldersQueryDto,
  MoveFileDto,
  RenameFileDto,
  FolderDto,
  ChangeFolderDto,
  RenameFolderDto,
  PublishFileDto,
} from "./files.dto";
import {
  FileDownloadResponseDto,
  FileListResponseDto,
  FileResponseDto,
  VideoPlaybackResponseDto,
  RecordingTranscriptResponseDto,
} from "./files.models";

@Controller("groups/:groupId/files")
@ApiTags("Files")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class GroupFilesController {
  constructor(private readonly files: FilesService) {}
  @Patch("folders")
  @HttpCode(204)
  @ApiOperation({ summary: "Đổi tên thư mục và toàn bộ đường dẫn con" })
  @ApiSuccess(204)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FOLDER_NOT_FOUND"],
    [409, "FOLDER_EXISTS", "FOLDER_BUSY"],
  )
  async renameFolder(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Body() dto: RenameFolderDto,
  ) {
    await this.files.changeFolder(
      auth.user.id,
      groupId,
      dto.folderPath!,
      dto.name,
      dto.force,
    );
  }
  @Delete("folders")
  @HttpCode(204)
  @ApiOperation({
    summary: "Xóa thư mục và các file bên trong; tạo job dọn storage",
  })
  @ApiSuccess(204)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FOLDER_NOT_FOUND"],
    [409, "FILE_IN_USE", "FOLDER_BUSY"],
  )
  async removeFolder(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Body() dto: ChangeFolderDto,
  ) {
    await this.files.changeFolder(
      auth.user.id,
      groupId,
      dto.folderPath,
      undefined,
      dto.force,
    );
  }
  @Post("folders/download")
  @HttpCode(200)
  @ApiOperation({
    summary: "Tải thư mục dưới dạng ZIP, giữ cấu trúc thư mục con",
  })
  @ApiProduces("application/zip")
  @ApiResponse({ status: 200, schema: { type: "string", format: "binary" } })
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FOLDER_NOT_FOUND"],
    [409, "FILE_NOT_READY"],
  )
  async downloadFolder(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Body() dto: FolderDto,
  ) {
    return new StreamableFile(
      await this.files.downloadFolder(auth.user.id, groupId, dto.folderPath),
      { type: "application/zip", disposition: "attachment" },
    );
  }
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
  constructor(
    private readonly files: FilesService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}

  @Get(":fileId/transcript")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Phụ đề có mốc thời gian của video" })
  @ApiSuccess(200, RecordingTranscriptResponseDto)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
    [409, "FILE_NOT_READY", "FILE_CHANGED"],
  )
  transcript(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
  ) {
    return this.files.transcript(auth.user.id, fileId, !!this.config.azureSpeech);
  }

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
  @Patch(":fileId/move")
  @ApiOperation({ summary: "Di chuyển tài liệu vào thư mục hoặc root" })
  @ApiSuccess(200, FileResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND", "DESTINATION_FOLDER_NOT_FOUND"],
  )
  move(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
    @Body() dto: MoveFileDto,
  ) {
    return this.files.moveFile(
      auth.user.id,
      fileId,
      dto.destinationFolderId ?? null,
    );
  }
  @Patch(":fileId/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Công bố hoặc ẩn tài liệu trong nhóm" })
  @ApiSuccess(200, FileResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FILE_NOT_FOUND"],
  )
  publish(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
    @Body() dto: PublishFileDto,
  ) {
    return this.files.publish(
      auth.user.id,
      fileId,
      dto.isPublished ?? true,
    );
  }
  @Post(":fileId/publish")
  @HttpCode(200)
  @ApiExcludeEndpoint()
  publishPost(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("fileId", UUIDParamPipe) fileId: string,
    @Body() dto: PublishFileDto,
  ) {
    return this.files.publish(
      auth.user.id,
      fileId,
      dto.isPublished ?? true,
    );
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

@Controller("groups/:groupId/folders")
@ApiTags("Folders")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class GroupFoldersController {
  constructor(private readonly files: FilesService) {}

  @Get()
  @ApiOperation({ summary: "Danh sách thư mục và breadcrumb trong nhóm" })
  @ApiParam({ name: "groupId", format: "uuid" })
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND"],
  )
  list(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Query() query: ListFoldersQueryDto,
  ) {
    return this.files.listFolders(auth.user.id, groupId, query.parentId);
  }

  @Post()
  @ApiOperation({ summary: "Tạo thư mục mới trong nhóm" })
  @ApiParam({ name: "groupId", format: "uuid" })
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "GROUP_NOT_FOUND", "PARENT_FOLDER_NOT_FOUND"],
    [409, "FOLDER_EXISTS"],
  )
  create(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.files.createFolder(
      auth.user.id,
      groupId,
      dto.name,
      dto.parentId,
    );
  }
}

@Controller("folders")
@ApiTags("Folders")
@ApiBearerAuth("accessToken")
@RequireAuth()
@ApiParam({ name: "folderId", format: "uuid" })
export class FoldersController {
  constructor(private readonly files: FilesService) {}

  @Patch(":folderId")
  @ApiOperation({ summary: "Đổi tên thư mục" })
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FOLDER_NOT_FOUND"],
    [409, "FOLDER_EXISTS"],
  )
  rename(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("folderId", UUIDParamPipe) folderId: string,
    @Body() dto: RenameFolderDto,
  ) {
    return this.files.renameFolder(auth.user.id, folderId, dto.name);
  }

  @Delete(":folderId")
  @HttpCode(204)
  @ApiOperation({ summary: "Xóa thư mục (chuyển file bên trong về thư mục cha)" })
  @ApiSuccess(204)
  @ApiErrors(
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "FOLDER_NOT_FOUND"],
  )
  remove(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("folderId", UUIDParamPipe) folderId: string,
  ) {
    return this.files.removeFolder(auth.user.id, folderId);
  }
}
