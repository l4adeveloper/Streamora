import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
  createParamDecorator,
} from "@nestjs/common";
import { ApiError } from "../api-error";
import { AccessTokenService } from "../../modules/auth/access-token.service";
import { SessionStore } from "../../modules/auth/session-store.service";
import type { AuthenticatedRequest } from "./auth.types";

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStore,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? "",
    );
    if (!match)
      throw new ApiError(401, "UNAUTHENTICATED", "Bạn cần đăng nhập.");
    const claims = this.tokens.verify(match[1]);
    request.auth = await this.sessions.authenticate(
      claims.userId,
      claims.sessionId,
    );
    return true;
  }
}

export const RequireAuth = () => UseGuards(AccessTokenGuard);

export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const identity = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().auth;
    if (!identity)
      throw new ApiError(401, "UNAUTHENTICATED", "Bạn cần đăng nhập.");
    return identity;
  },
);
