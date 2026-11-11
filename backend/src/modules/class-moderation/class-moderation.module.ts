import { Module } from "@nestjs/common";
import { SessionSecurityModule } from "../auth/session-security.module";
import { ClassMediaModule } from "../class-media/class-media.module";
import { ClassSessionsModule } from "../class-sessions/class-sessions.module";
import { ClassModerationController } from "./class-moderation.controller";
import { ClassModerationService } from "./class-moderation.service";

@Module({
  imports: [ClassSessionsModule, ClassMediaModule, SessionSecurityModule],
  controllers: [ClassModerationController],
  providers: [ClassModerationService],
})
export class ClassModerationModule {}
