import { Module } from "@nestjs/common";
import { GroupAccessService } from "../memberships/group-access.service";
import { FileStorageService } from "../files/file-storage.service";
import { StorageLocationsService } from "../files/storage-locations.service";
import { VideoRenditionCatalog } from "../files/video-rendition-catalog";
import { VideoCloudBridge } from "./video-cloud-bridge";
import { VideoProcessingService } from "./video-processing.service";
import { VideoStorage, VIDEO_STORAGE_LOCATIONS } from "./video-storage";
import { VideoDelivery } from "./video-delivery";
import { VideoWorker } from "./video-worker";
import { DatabaseVideoCatalog } from "./database-video-catalog";
import { VIDEO_JOBS, VIDEO_LOCAL_FILES } from "./video-job-store";

// API and local processing services. Lambda builds its own independent runtime.
@Module({
  providers: [
    GroupAccessService,
    FileStorageService,
    StorageLocationsService,
    VideoStorage,
    { provide: VIDEO_STORAGE_LOCATIONS, useExisting: StorageLocationsService },
    { provide: VIDEO_LOCAL_FILES, useExisting: FileStorageService },
    { provide: VIDEO_JOBS, useExisting: VideoProcessingService },
    VideoProcessingService,
    VideoCloudBridge,
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
