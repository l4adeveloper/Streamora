import { Module } from "@nestjs/common";
import { SessionSecurityModule } from "../auth/session-security.module";
import { GroupAccessService } from "./group-access.service";
import { GroupAccessGuard } from "./group-access.guard";
import { MembershipsService } from "./memberships.service";
import {
  MembershipLookupController,
  MembershipsController,
} from "./memberships.controller";
import { MembershipGateway } from "./membership.gateway";
import { ChatStore } from "./chat-store";
import { ChatController } from "./chat.controller";

@Module({
  imports: [SessionSecurityModule],
  controllers: [
    MembershipLookupController,
    MembershipsController,
    ChatController,
  ],
  providers: [
    ChatStore,
    GroupAccessService,
    GroupAccessGuard,
    MembershipsService,
    MembershipGateway,
  ],
  exports: [
    GroupAccessService,
    GroupAccessGuard,
    MembershipsService,
    MembershipGateway,
    SessionSecurityModule,
  ],
})
export class MembershipsModule {}
