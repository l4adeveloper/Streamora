import { Module } from "@nestjs/common";
import { FilesModule } from "../files/files.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { UploadsController } from "./uploads.controller";
import { UploadsService } from "./uploads.service";
import { MultipartStorageService } from "./multipart-storage.service";
@Module({
  imports: [FilesModule, MembershipsModule],
  controllers: [UploadsController],
  providers: [UploadsService, MultipartStorageService],
})
export class UploadsModule {}
