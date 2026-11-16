import { Module } from "@nestjs/common";
import { SessionSecurityModule } from "../auth/session-security.module";
import { ClassMediaModule } from "../class-media/class-media.module";
import { ClassSessionsModule } from "../class-sessions/class-sessions.module";
import { FilesModule } from "../files/files.module";
import { RecordingTranscriptWorker } from "./recording-transcript.worker";
import { ClassRecordingsController } from "./class-recordings.controller";
import { ClassRecordingsService } from "./class-recordings.service";
import { CloudRecordingWorker } from "./cloud-recording.worker";

@Module({
  imports: [
    ClassSessionsModule,
    ClassMediaModule,
    SessionSecurityModule,
    FilesModule,
  ],
  controllers: [ClassRecordingsController],
  providers: [ClassRecordingsService, CloudRecordingWorker, RecordingTranscriptWorker],
})
export class ClassRecordingsModule {}
