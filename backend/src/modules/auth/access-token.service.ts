import { Inject, Injectable } from "@nestjs/common";
import { isUUID } from "class-validator";
import * as jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { AUTH_POLICY } from "../../config/auth-policy";
import { ApiError } from "../../common/api-error";

@Injectable()
export class AccessTokenService {
  constructor(@Inject(APP_CONFIG) private readonly config: EnvironmentConfig) {}

  issue(userId: string, sessionId: string, expiresIn: number, now: Date) {
    return jwt.sign(
      { sid: sessionId, iat: Math.floor(now.getTime() / 1000) },
      this.config.auth.accessTokenSecret,
      {
        algorithm: "HS256",
        subject: userId,
        jwtid: randomUUID(),
        expiresIn,
        issuer: AUTH_POLICY.accessTokenIssuer,
        audience: AUTH_POLICY.accessTokenAudience,
      },
    );
  }

  verify(token: string): { userId: string; sessionId: string } {
    try {
      if (token.length > 8192) throw new Error();
      const payload = jwt.verify(token, this.config.auth.accessTokenSecret, {
        algorithms: ["HS256"],
        issuer: AUTH_POLICY.accessTokenIssuer,
        audience: AUTH_POLICY.accessTokenAudience,
      });
      if (
        typeof payload !== "object" ||
        typeof payload.sub !== "string" ||
        !isUUID(payload.sub, "4") ||
        typeof payload.sid !== "string" ||
        !isUUID(payload.sid, "4") ||
        typeof payload.jti !== "string" ||
        !isUUID(payload.jti, "4") ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp)
      )
        throw new Error();
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
      );
    }
  }
}
