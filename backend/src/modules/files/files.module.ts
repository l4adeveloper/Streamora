import { Module } from "@nestjs/common";
import { MembershipsModule } from "../memberships/memberships.module";
import { FilesController, GroupFilesController } from "./files.controller";
import { FilesService } from "./files.service";
import { FileStorageService } from "./file-storage.service";
import { FileCleanupService } from "./file-cleanup.service";
import { LocalFileDownloadController } from "./local-file-download.controller";
@Module({
  imports: [MembershipsModule],
  controllers: [
    FilesController,
    GroupFilesController,
    LocalFileDownloadController,
  ],
  providers: [FilesService, FileStorageService, FileCleanupService],
  exports: [FilesService],
})
export class FilesModule {}
