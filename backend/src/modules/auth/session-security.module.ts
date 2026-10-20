import { Module } from "@nestjs/common";
import { AccessTokenService } from "./access-token.service";
import { AccessTokenGuard } from "../../common/auth/access-token.guard";
import { SessionStore } from "./session-store.service";

@Module({
  providers: [AccessTokenService, AccessTokenGuard, SessionStore],
  exports: [AccessTokenService, AccessTokenGuard, SessionStore],
})
export class SessionSecurityModule {}
