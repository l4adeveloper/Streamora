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
  uploads?: {
    maxSize: number;
    partSize: number;
    ttlSeconds: number;
    localPort: number;
    maxActivePerUser?: number;
    maxActivePerGroup?: number;
    maxActiveBytesPerUser?: number;
    maxActiveBytesPerGroup?: number;
  };
  files?: {
    driver?: "local" | "s3";
    localDirectory?: string;
    publicBaseUrl?: string;
    bucket: string;
    region: string;
    downloadTtlSeconds: number;
    cleanupEnabled: boolean;
  };
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

  const fileBucket = env.FILES_S3_BUCKET ?? "";
  const fileDriver =
    env.FILES_STORAGE_DRIVER ?? (nodeEnv === "production" ? "s3" : "local");
  if (!["local", "s3"].includes(fileDriver)) invalid("FILES_STORAGE_DRIVER");
  const localDirectory = resolve(
    __dirname,
    "../../",
    env.FILES_LOCAL_DIRECTORY ?? ".local-storage/files",
  );
  const publicBaseUrl =
    env.FILES_PUBLIC_BASE_URL ??
    `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  try {
    const url = new URL(publicBaseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== publicBaseUrl ||
      url.username ||
      url.password ||
      (nodeEnv === "production" &&
        fileDriver === "local" &&
        url.protocol !== "https:")
    )
      invalid("FILES_PUBLIC_BASE_URL");
  } catch {
    invalid("FILES_PUBLIC_BASE_URL");
  }
  if (fileBucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(fileBucket))
    invalid("FILES_S3_BUCKET");
  const fileRegion = env.FILES_S3_REGION ?? "ap-southeast-1";
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(fileRegion)) invalid("FILES_S3_REGION");
  const requestedDownloadTtl = positiveInteger(
    env,
    "FILES_DOWNLOAD_TTL_SECONDS",
    60,
  );
  if (requestedDownloadTtl > 300) invalid("FILES_DOWNLOAD_TTL_SECONDS");
  const downloadTtlSeconds = Math.min(60, requestedDownloadTtl);
  const cleanupEnabled = env.FILES_CLEANUP_ENABLED ?? "true";
  if (!["true", "false"].includes(cleanupEnabled))
    invalid("FILES_CLEANUP_ENABLED");
  return {
    nodeEnv: nodeEnv as EnvironmentConfig["nodeEnv"],
    uploads: readUploadConfig(env),
    host,
    port,
    docsEnabled: rawDocs === "true",
    webOrigin,
    databaseUrl: databaseUrl!,
    files: {
      driver: fileDriver as "local" | "s3",
      localDirectory,
      publicBaseUrl,
      bucket: fileBucket,
      region: fileRegion,
      downloadTtlSeconds,
      cleanupEnabled: cleanupEnabled === "true",
    },
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

function readUploadConfig(env: NodeJS.ProcessEnv) {
  const maxSize = positiveInteger(env, "UPLOAD_MAX_SIZE_BYTES", 2 * 1024 ** 3);
  const partSize = positiveInteger(
    env,
    "UPLOAD_PART_SIZE_BYTES",
    8 * 1024 ** 2,
  );
  const ttlSeconds = positiveInteger(env, "UPLOAD_TTL_SECONDS", 86400);
  const localPort = positiveInteger(env, "UPLOAD_LOCAL_PORT", 4002);
  if (partSize < 5 * 1024 ** 2 || partSize > 64 * 1024 ** 2)
    invalid("UPLOAD_PART_SIZE_BYTES");
  if (maxSize > partSize * 10000 || !Number.isSafeInteger(maxSize))
    invalid("UPLOAD_MAX_SIZE_BYTES");
  if (ttlSeconds > 604800) invalid("UPLOAD_TTL_SECONDS");
  if (localPort > 65535) invalid("UPLOAD_LOCAL_PORT");
  const maxActivePerUser = positiveInteger(
    env,
    "UPLOAD_MAX_ACTIVE_PER_USER",
    4,
  );
  const maxActivePerGroup = positiveInteger(
    env,
    "UPLOAD_MAX_ACTIVE_PER_GROUP",
    32,
  );
  const maxActiveBytesPerUser = positiveInteger(
    env,
    "UPLOAD_MAX_ACTIVE_BYTES_PER_USER",
    8 * 1024 ** 3,
  );
  const maxActiveBytesPerGroup = positiveInteger(
    env,
    "UPLOAD_MAX_ACTIVE_BYTES_PER_GROUP",
    64 * 1024 ** 3,
  );
  if (maxActivePerUser > maxActivePerGroup)
    invalid("UPLOAD_MAX_ACTIVE_PER_USER");
  if (maxActiveBytesPerUser > maxActiveBytesPerGroup)
    invalid("UPLOAD_MAX_ACTIVE_BYTES_PER_USER");
  return {
    maxSize,
    partSize,
    ttlSeconds,
    localPort,
    maxActivePerUser,
    maxActivePerGroup,
    maxActiveBytesPerUser,
    maxActiveBytesPerGroup,
  };
}
