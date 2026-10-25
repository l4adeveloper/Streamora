import { AUTH_CONSTRAINTS } from "@streamora/contracts";

export const API_PREFIX = "api/v1";

// Authentication policy used by the T01 endpoints and access-token guard.
export const AUTH_POLICY = Object.freeze({
  ...AUTH_CONSTRAINTS,
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 604800,
  refreshRecoveryWindowMs: 10000,
  accessTokenIssuer: "streamora-api",
  accessTokenAudience: "streamora-web",
  refreshCookieName: "refreshToken",
  refreshCookiePath: `/${API_PREFIX}/auth`,
});
