import { Module } from "@nestjs/common";
import { SessionSecurityModule } from "../auth/session-security.module";
import { VideoProcessingCoreModule } from "./video-processing-core.module";
import {
  FileProcessingController,
  RecordingProcessingController,
  VideoMediaController,
} from "./video-processing.controller";

@Module({
  imports: [SessionSecurityModule, VideoProcessingCoreModule],
  controllers: [
    FileProcessingController,
    RecordingProcessingController,
    VideoMediaController,
  ],
  exports: [VideoProcessingCoreModule],
})
export class VideoProcessingModule {}
