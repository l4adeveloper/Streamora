import { Module } from "@nestjs/common";
import { MembershipsModule } from "../memberships/memberships.module";
import {
  FilesController,
  FoldersController,
  GroupFilesController,
  GroupFoldersController,
} from "./files.controller";
import { FilesService } from "./files.service";
import { FileStorageService } from "./file-storage.service";
import { FileCleanupService } from "./file-cleanup.service";
import { LocalFileDownloadController } from "./local-file-download.controller";
import { VideoPlaybackService } from "./video-playback.service";
import { StorageLocationsService } from "./storage-locations.service";
import {
  VideoRenditionCatalog,
  SourceOnlyVideoCatalog,
} from "./video-rendition-catalog";
@Module({
  imports: [MembershipsModule],
  controllers: [
    FilesController,
    FoldersController,
    GroupFilesController,
    GroupFoldersController,
    LocalFileDownloadController,
  ],
  providers: [
    FilesService,
    FileStorageService,
    FileCleanupService,
    StorageLocationsService,
    VideoPlaybackService,
    { provide: VideoRenditionCatalog, useClass: SourceOnlyVideoCatalog },
  ],
  exports: [FilesService, FileStorageService],
})
export class FilesModule {}
