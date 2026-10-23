import { Module } from "@nestjs/common";
import { MembershipsModule } from "../memberships/memberships.module";
import {
  ClassSessionsController,
  GroupClassSessionsController,
  MeetsController,
} from "./class-sessions.controller";
import { ClassSessionsService } from "./class-sessions.service";
import { ClassSessionAccessService } from "./class-session-access.service";
import { ClassSessionCommandsService } from "./class-session-commands.service";
import { ClassAdmissionsService } from "./class-admissions.service";
import { ClassAdmissionsController } from "./class-admissions.controller";
import { ClassPresenceService } from "./class-presence.service";
import { ClassSessionsGateway } from "./class-sessions.gateway";
import { SessionSecurityModule } from "../auth/session-security.module";
import { ClassParticipantService } from "./class-participant.service";
import { ClassParticipantGuard } from "./class-participant.guard";
import { ClassSessionEventsModule } from "./class-session-events.module";

@Module({
  imports: [MembershipsModule, SessionSecurityModule, ClassSessionEventsModule],
  controllers: [
    GroupClassSessionsController,
    ClassSessionsController,
    MeetsController,
    ClassAdmissionsController,
  ],
  providers: [
    ClassSessionsService,
    ClassSessionAccessService,
    ClassSessionCommandsService,
    ClassAdmissionsService,
    ClassPresenceService,
    ClassSessionsGateway,
    ClassParticipantService,
    ClassParticipantGuard,
  ],
  exports: [
    ClassSessionsService,
    ClassAdmissionsService,
    ClassSessionAccessService,
    ClassParticipantService,
    ClassParticipantGuard,
    SessionSecurityModule,
    ClassSessionEventsModule,
  ],
})
export class ClassSessionsModule {}
