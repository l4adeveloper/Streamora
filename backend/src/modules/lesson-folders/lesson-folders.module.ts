import { Module } from "@nestjs/common";
import { MembershipsModule } from "../memberships/memberships.module";
import { VideoProcessingModule } from "../video-processing/video-processing.module";
import { LessonFoldersController } from "./lesson-folders.controller";
import { LessonFoldersService } from "./lesson-folders.service";
import { AzureLessonSummary } from "./azure-lesson-summary";
@Module({
  imports: [MembershipsModule, VideoProcessingModule],
  controllers: [LessonFoldersController],
  providers: [LessonFoldersService, AzureLessonSummary],
})
export class LessonFoldersModule {}
