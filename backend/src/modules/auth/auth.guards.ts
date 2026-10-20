import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiError } from "../../common/api-error";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
// Compatibility exports for modules created during T01 step 3.
export {
  AccessTokenGuard,
  CurrentAuth,
} from "../../common/auth/access-token.guard";

@Injectable()
export class AuthOriginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: EnvironmentConfig) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers.origin !== this.config.webOrigin)
      throw new ApiError(
        403,
        "ORIGIN_NOT_ALLOWED",
        "Nguồn gửi yêu cầu không được phép.",
      );
    return true;
  }
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<
    string,
    { count: number; expiresAt: number }
  >();

  canActivate(context: ExecutionContext) {
    const action = context.getHandler().name;
    const policy =
      action === "register"
        ? { limit: 20, windowMs: 900000 }
        : { limit: 30, windowMs: 60000 };
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const now = Date.now();
    for (const [key, bucket] of this.buckets)
      if (bucket.expiresAt <= now) this.buckets.delete(key);
    const key = `${action}:${request.ip ?? request.socket.remoteAddress}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10000)
        throw new ApiError(429, "RATE_LIMITED", "Vui lòng thử lại sau.");
      bucket = { count: 0, expiresAt: now + policy.windowMs };
      this.buckets.set(key, bucket);
    }
    if (++bucket.count > policy.limit) {
      response.setHeader(
        "Retry-After",
        Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
      );
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
      );
    }
    return true;
  }
}
