import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { AUTH_POLICY } from "./auth-policy";

export interface EnvironmentConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  docsEnabled: boolean;
  webOrigin: string;
  databaseUrl: string;
  /** Trusted application overrides; omitted deployments use the shared protocol defaults. */
  sessionRealtime?: {
    pollIntervalMs: number;
    sweepIntervalMs: number;
    heartbeatIntervalMs: number;
    leaseTtlMs: number;
  };
  auth: {
    accessTokenSecret: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    cookie: {
      name: string;
      path: string;
      httpOnly: true;
      secure: boolean;
      sameSite: "lax" | "strict" | "none";
    };
  };
}

export function loadEnvironmentFile(path = resolve(__dirname, "../../.env")) {
  try {
    // Shell/deployment variables take precedence over local configuration.
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class ConfigurationError extends Error {}

function invalid(key: string): never {
  // Do not include the invalid value: it may contain a credential.
  throw new ConfigurationError(`Cấu hình ${key} không hợp lệ.`);
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
) {
  const raw = env[key] ?? String(fallback);
  if (!/^[1-9]\d*$/.test(raw)) return invalid(key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return invalid(key);
  return value;
}

export function readEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv))
    invalid("NODE_ENV");

  const port = positiveInteger(env, "API_PORT", 4000);
  if (port > 65535) invalid("API_PORT");
  const host = env.API_HOST ?? "127.0.0.1";
  if (!host.trim()) invalid("API_HOST");
  const rawDocs = env.API_DOCS_ENABLED ?? String(nodeEnv === "development");
  if (rawDocs !== "true" && rawDocs !== "false") invalid("API_DOCS_ENABLED");

  const webOrigin = env.WEB_ORIGIN ?? "http://127.0.0.1:3000";
  let origin: URL;
  try {
    origin = new URL(webOrigin);
  } catch {
    return invalid("WEB_ORIGIN");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== webOrigin
  ) {
    invalid("WEB_ORIGIN");
  }
  if (nodeEnv === "production" && origin.protocol !== "https:")
    invalid("WEB_ORIGIN");

  const secret = env.ACCESS_TOKEN_SECRET;
  if (
    !secret?.trim() ||
    Buffer.byteLength(secret, "utf8") < 32 ||
    secret.startsWith("replace-with-")
  ) {
    invalid("ACCESS_TOKEN_SECRET");
  }

  const accessTokenTtlSeconds = positiveInteger(
    env,
    "ACCESS_TOKEN_TTL_SECONDS",
    AUTH_POLICY.accessTokenTtlSeconds,
  );
  const refreshTokenTtlSeconds = positiveInteger(
    env,
    "REFRESH_TOKEN_TTL_SECONDS",
    AUTH_POLICY.refreshTokenTtlSeconds,
  );
  if (refreshTokenTtlSeconds <= accessTokenTtlSeconds)
    invalid("REFRESH_TOKEN_TTL_SECONDS");

  const rawSecure = env.AUTH_COOKIE_SECURE ?? String(nodeEnv === "production");
  if (rawSecure !== "true" && rawSecure !== "false")
    invalid("AUTH_COOKIE_SECURE");
  const secure = rawSecure === "true";
  if (nodeEnv === "production" && !secure) invalid("AUTH_COOKIE_SECURE");
  const sameSite = env.AUTH_COOKIE_SAME_SITE ?? "lax";
  if (!["lax", "strict", "none"].includes(sameSite))
    invalid("AUTH_COOKIE_SAME_SITE");
  if (sameSite === "none" && !secure) invalid("AUTH_COOKIE_SAME_SITE");

  const databaseUrl = env.DATABASE_URL;
  try {
    const database = new URL(databaseUrl ?? "");
    if (
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      !database.hostname ||
      database.pathname.length < 2
    ) {
      invalid("DATABASE_URL");
    }
  } catch {
    return invalid("DATABASE_URL");
  }

  return {
    nodeEnv: nodeEnv as EnvironmentConfig["nodeEnv"],
    host,
    port,
    docsEnabled: rawDocs === "true",
    webOrigin,
    databaseUrl: databaseUrl!,
    auth: {
      accessTokenSecret: secret!,
      accessTokenTtlSeconds,
      refreshTokenTtlSeconds,
      cookie: {
        name: AUTH_POLICY.refreshCookieName,
        path: AUTH_POLICY.refreshCookiePath,
        httpOnly: true,
        secure,
        sameSite: sameSite as EnvironmentConfig["auth"]["cookie"]["sameSite"],
      },
    },
  };
}
