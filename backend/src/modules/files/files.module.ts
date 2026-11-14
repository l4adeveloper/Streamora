import { FolderUploadCancellation } from "./folder-upload-cancellation";
import { Module } from "@nestjs/common";
import { MembershipsModule } from "../memberships/memberships.module";
import {
  FilesController,
  FoldersController,
  GroupFilesController,
  GroupFoldersController,
} from "./files.controller";
import { FilesService } from "./files.service";
import { FileCleanupService } from "./file-cleanup.service";
import { LocalFileDownloadController } from "./local-file-download.controller";
import { VideoPlaybackService } from "./video-playback.service";
import { VideoProcessingModule } from "../video-processing/video-processing.module";
@Module({
  imports: [MembershipsModule, VideoProcessingModule],
  controllers: [
    FilesController,
    FoldersController,
    GroupFilesController,
    GroupFoldersController,
    LocalFileDownloadController,
  ],
  providers: [
    FolderUploadCancellation,
    FilesService,
    FileCleanupService,
    VideoPlaybackService,
  ],
  exports: [FilesService, VideoProcessingModule, FolderUploadCancellation],
})
export class FilesModule {}
