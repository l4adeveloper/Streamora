import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module";
import { SessionSecurityModule } from "./session-security.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { AuthOriginGuard, AuthRateLimitGuard } from "./auth.guards";

@Module({
  imports: [UsersModule, SessionSecurityModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    AuthOriginGuard,
    AuthRateLimitGuard,
  ],
})
export class AuthModule {}
