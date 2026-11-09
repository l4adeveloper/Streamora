import { Module } from "@nestjs/common";
import { ClassSessionsModule } from "../class-sessions/class-sessions.module";
import { IvsService } from "./ivs.service";
import { ClassMediaService } from "./class-media.service";
import { ClassMediaWorker } from "./class-media.worker";
import { ClassMediaController } from "./class-media.controller";
import { IvsEventsModule } from "./ivs-events.module";
import { SessionSecurityModule } from "../auth/session-security.module";
@Module({
  imports: [ClassSessionsModule, SessionSecurityModule, IvsEventsModule],
  providers: [IvsService, ClassMediaService, ClassMediaWorker],
  controllers: [ClassMediaController],
  exports: [ClassMediaService, IvsService, IvsEventsModule],
})
export class ClassMediaModule {}
