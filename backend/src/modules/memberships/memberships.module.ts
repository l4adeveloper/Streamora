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
import { MembershipMediaService } from "./membership-media.service";

@Module({
  imports: [SessionSecurityModule],
  controllers: [MembershipLookupController, MembershipsController],
  providers: [
    GroupAccessService,
    GroupAccessGuard,
    MembershipsService,
    MembershipGateway,
    MembershipMediaService,
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
