import { Module } from "@nestjs/common";
import { SessionSecurityModule } from "../auth/session-security.module";
import { ClassMediaModule } from "../class-media/class-media.module";
import { ClassSessionsModule } from "../class-sessions/class-sessions.module";
import { FilesModule } from "../files/files.module";
import { RecordingTranscriptWorker } from "./recording-transcript.worker";
import { ClassRecordingsController } from "./class-recordings.controller";
import { ClassRecordingsService } from "./class-recordings.service";
import { CloudRecordingWorker } from "./cloud-recording.worker";
import { MembershipsModule } from "../memberships/memberships.module";
import {
  GroupRecordingsController,
  RecordingPlaybackController,
} from "./recording-playback.controller";
import { RecordingPlaybackService } from "./recording-playback.service";
import { RecordingSourceService } from "./recording-source.service";
import { RecordingMediaController } from "./recording-media.controller";
import { ReplicaStatusController } from "./replica-status.controller";

@Module({
  imports: [
    ClassSessionsModule,
    ClassMediaModule,
    SessionSecurityModule,
    FilesModule,
    MembershipsModule,
  ],
  controllers: [
    ClassRecordingsController,
    GroupRecordingsController,
    RecordingPlaybackController,
    RecordingMediaController,
    ReplicaStatusController,
  ],
  providers: [
    ClassRecordingsService,
    CloudRecordingWorker,
    RecordingTranscriptWorker,
    RecordingPlaybackService,
    RecordingSourceService,
  ],
})
export class ClassRecordingsModule {}
