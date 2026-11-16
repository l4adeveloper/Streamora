import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { AUTH_POLICY } from "./auth-policy";
import {
  readVideoConfig,
  type VideoConfig,
} from "../modules/video-processing/video-config";

export interface EnvironmentConfig {
  video?: VideoConfig;
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  docsEnabled: boolean;
  webOrigin: string;
  databaseUrl: string;
  azureRealtime?: { secretId: string; region: string };
  azureSpeech?: {
    region: string;
    key: string;
    locales: string[];
    ffmpegPath: string;
  };
  ivs?: {
    enabled: boolean;
    region: string;
    credentials?: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    tokenTtlSeconds: number;
    eventsQueueUrl: string;
    workerEnabled: boolean;
    recording?: { storageArn: string; encoderArn: string };
  };
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
  const ivsEnabled = env.IVS_ENABLED ?? "false";
  const ivsWorker = env.IVS_WORKER_ENABLED ?? "false";
  if (!["true", "false"].includes(ivsEnabled)) invalid("IVS_ENABLED");
  if (!["true", "false"].includes(ivsWorker)) invalid("IVS_WORKER_ENABLED");
  const ivsRegion = env.AWS_REGION ?? "ap-northeast-1";
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(ivsRegion)) invalid("AWS_REGION");
  const realtimeProvider = env.REALTIME_PROVIDER ?? "local";
  if (!["local", "azure"].includes(realtimeProvider))
    invalid("REALTIME_PROVIDER");
  const realtimeSecretId = env.AZURE_WEB_PUBSUB_SECRET_ID?.trim();
  if (realtimeProvider === "azure" && !realtimeSecretId)
    invalid("AZURE_WEB_PUBSUB_SECRET_ID");
  const awsAccessKeyId = env.AWS_ACCESS_KEY_ID?.trim() || undefined;
  const awsSecretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim() || undefined;
  const awsSessionToken = env.AWS_SESSION_TOKEN?.trim() || undefined;
  if (awsAccessKeyId && !awsSecretAccessKey) invalid("AWS_SECRET_ACCESS_KEY");
  if ((awsSecretAccessKey || awsSessionToken) && !awsAccessKeyId)
    invalid("AWS_ACCESS_KEY_ID");
  const ivsTtl = positiveInteger(env, "IVS_TOKEN_TTL_SECONDS", 60);
  if (ivsTtl !== 60) invalid("IVS_TOKEN_TTL_SECONDS");
  const eventsQueueUrl = env.IVS_EVENTS_QUEUE_URL ?? "";
  if (eventsQueueUrl) {
    try {
      const url = new URL(eventsQueueUrl);
      if (
        url.protocol !== "https:" ||
        url.hostname !== `sqs.${ivsRegion}.amazonaws.com` ||
        !/^\/\d{12}\/[\w-]+$/.test(url.pathname) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        invalid("IVS_EVENTS_QUEUE_URL");
    } catch {
      invalid("IVS_EVENTS_QUEUE_URL");
    }
  }
  if (ivsWorker === "true" && (ivsEnabled !== "true" || !eventsQueueUrl))
    invalid("IVS_WORKER_ENABLED");
  const recordingStorageArn = env.IVS_RECORDING_STORAGE_ARN?.trim();
  const recordingEncoderArn = env.IVS_RECORDING_ENCODER_ARN?.trim();
  if (recordingStorageArn || recordingEncoderArn) {
    if (
      !recordingStorageArn?.match(
        new RegExp(
          `^arn:aws:ivs:${ivsRegion}:\\d{12}:storage-configuration/[A-Za-z0-9]+$`,
        ),
      )
    )
      invalid("IVS_RECORDING_STORAGE_ARN");
    if (
      !recordingEncoderArn?.match(
        new RegExp(
          `^arn:aws:ivs:${ivsRegion}:\\d{12}:encoder-configuration/[A-Za-z0-9]+$`,
        ),
      )
    )
      invalid("IVS_RECORDING_ENCODER_ARN");
    if (
      fileDriver !== "s3" ||
      fileRegion !== ivsRegion ||
      ivsEnabled !== "true"
    )
      invalid("IVS_RECORDING_STORAGE_ARN");
  }
  return {
    video: readVideoConfig(env, fileDriver, fileRegion),
    nodeEnv: nodeEnv as EnvironmentConfig["nodeEnv"],
    uploads: readUploadConfig(env),
    host,
    port,
    docsEnabled: rawDocs === "true",
    webOrigin,
    databaseUrl: databaseUrl!,
    ...(realtimeProvider === "azure" && realtimeSecretId
      ? { azureRealtime: { secretId: realtimeSecretId, region: ivsRegion } }
      : {}),
    azureSpeech: readAzureSpeechConfig(env),
    ivs: {
      enabled: ivsEnabled === "true",
      region: ivsRegion,
      credentials:
        awsAccessKeyId && awsSecretAccessKey
          ? {
              accessKeyId: awsAccessKeyId,
              secretAccessKey: awsSecretAccessKey,
              ...(awsSessionToken ? { sessionToken: awsSessionToken } : {}),
            }
          : undefined,
      tokenTtlSeconds: ivsTtl,
      eventsQueueUrl,
      workerEnabled: ivsWorker === "true",
      ...(recordingStorageArn && recordingEncoderArn
        ? {
            recording: {
              storageArn: recordingStorageArn,
              encoderArn: recordingEncoderArn,
            },
          }
        : {}),
    },
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

function readAzureSpeechConfig(
  env: NodeJS.ProcessEnv,
): EnvironmentConfig["azureSpeech"] {
  const region = env.AZURE_SPEECH_REGION?.trim();
  const key = env.AZURE_SPEECH_KEY?.trim();
  if (!region && !key) return undefined;
  if (!region || !/^[a-z][a-z0-9]+$/.test(region))
    invalid("AZURE_SPEECH_REGION");
  if (!key) invalid("AZURE_SPEECH_KEY");

  const locales = (env.AZURE_SPEECH_LOCALES ?? "vi-VN,en-US")
    .split(",")
    .map((locale) => locale.trim());
  if (locales.length > 4 || locales.includes(""))
    invalid("AZURE_SPEECH_LOCALES");
  let canonical: string[];
  try {
    canonical = Intl.getCanonicalLocales(locales);
    const languages = new Set(
      canonical.map((locale) => new Intl.Locale(locale).language),
    );
    if (languages.size !== locales.length) invalid("AZURE_SPEECH_LOCALES");
  } catch {
    invalid("AZURE_SPEECH_LOCALES");
  }
  const override = env.RECORDING_FFMPEG_PATH?.trim();
  const bundledPath = override
    ? null
    : (require("ffmpeg-static") as string | null);
  return {
    region,
    key,
    locales: canonical,
    ffmpegPath:
      override ||
      (bundledPath && existsSync(bundledPath) ? bundledPath : "ffmpeg"),
  };
}
