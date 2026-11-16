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
import { MediaConvertEncoder } from "./mediaconvert-encoder";
import { VideoReplicationWorker } from "./video-replication.worker";

// The API process hosts the worker in both local and AWS deployments.
@Module({
  providers: [
    VideoReplicationWorker,
    GroupAccessService,
    FileStorageService,
    StorageLocationsService,
    VideoStorage,
    { provide: VIDEO_STORAGE_LOCATIONS, useExisting: StorageLocationsService },
    VideoProcessingService,
    VideoCloudBridge,
    VideoDelivery,
    {
      provide: VideoWorker,
      useFactory: (
        service: VideoProcessingService,
        cloud: VideoCloudBridge,
        storage: VideoStorage,
        files: FileStorageService,
      ) =>
        cloud.store
          ? new VideoWorker(
              cloud.store,
              new VideoStorage(cloud.store),
              undefined,
              new MediaConvertEncoder(cloud.store.config.video),
            )
          : new VideoWorker(service, storage, files),
      inject: [
        VideoProcessingService,
        VideoCloudBridge,
        VideoStorage,
        FileStorageService,
      ],
    },
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
