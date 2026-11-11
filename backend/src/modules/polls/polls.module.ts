import { Module } from "@nestjs/common";
import { SessionSecurityModule } from "../auth/session-security.module";
import { ClassSessionsModule } from "../class-sessions/class-sessions.module";
import { PollsController } from "./polls.controller";
import { PollsService } from "./polls.service";

@Module({
  imports: [ClassSessionsModule, SessionSecurityModule],
  controllers: [PollsController],
  providers: [PollsService],
})
export class PollsModule {}
