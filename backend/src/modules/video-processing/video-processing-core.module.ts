import { Module } from "@nestjs/common";
import { GroupAccessService } from "../memberships/group-access.service";
import { FileStorageService } from "../files/file-storage.service";
import { StorageLocationsService } from "../files/storage-locations.service";
import { VideoRenditionCatalog } from "../files/video-rendition-catalog";
import { VideoProcessingService } from "./video-processing.service";
import { VideoStorage } from "./video-storage";
import { VideoDelivery } from "./video-delivery";
import { VideoWorker } from "./video-worker";
import { DatabaseVideoCatalog } from "./database-video-catalog";

// Shared API/worker services. Background workers must not start HTTP/WebSocket
// gateways or unrelated chat/membership polling loops.
@Module({
  providers: [
    GroupAccessService,
    FileStorageService,
    StorageLocationsService,
    VideoStorage,
    VideoProcessingService,
    VideoDelivery,
    VideoWorker,
    { provide: VideoRenditionCatalog, useClass: DatabaseVideoCatalog },
  ],
  exports: [
    VideoStorage,
    FileStorageService,
    StorageLocationsService,
    VideoProcessingService,
    VideoDelivery,
    VideoWorker,
    VideoRenditionCatalog,
  ],
})
export class VideoProcessingCoreModule {}
