import { resolve } from "node:path";
import { existsSync } from "node:fs";
export interface VideoConfig {
  mode: "local" | "aws";
  workerEnabled: boolean;
  maxQuality: number;
  optionalQualities: number[];
  ffmpegPath: string;
  ffprobePath: string;
  scratchDirectory: string;
  outputBucket: string;
  roleArn: string;
  queueArn: string;
  mediaDomain: string;
  cloudFrontKeyPairId: string;
  cloudFrontSigningSecretId: string;
  replication?: { bucket: string; projectId: string };
  sourceRegionPreferences?: Record<string, "cloudfront" | "gcs">;
  gcsDelivery?: {
    bucket: string;
    projectId: string;
    domain: string;
    keyName: string;
    signingSecretId: string;
  };
  tableName: string;
  accountId: string;
  region: string;
}
export function readVideoConfig(
  env: NodeJS.ProcessEnv,
  driver: string,
  region: string,
): VideoConfig {
  const bad = (key: string): never => {
    throw new Error(`Cấu hình ${key} không hợp lệ.`);
  };
  const mode = env.VIDEO_MODE ?? (driver === "local" ? "local" : "aws");
  if (
    env.VIDEO_REPLICATION_ENABLED &&
    !["true", "false"].includes(env.VIDEO_REPLICATION_ENABLED)
  )
    bad("VIDEO_REPLICATION_ENABLED");
  const replicate = env.VIDEO_REPLICATION_ENABLED === "true";
  let sourceRegionPreferences: VideoConfig["sourceRegionPreferences"] = {};
  try {
    sourceRegionPreferences = JSON.parse(
      env.VIDEO_SOURCE_REGION_PREFERENCES ?? "{}",
    );
    if (
      !sourceRegionPreferences ||
      Array.isArray(sourceRegionPreferences) ||
      typeof sourceRegionPreferences !== "object" ||
      Object.entries(sourceRegionPreferences).some(
        ([key, value]) =>
          !/^[A-Z][A-Z0-9_-]{1,31}$/.test(key) ||
          !["cloudfront", "gcs"].includes(value),
      )
    )
      bad("VIDEO_SOURCE_REGION_PREFERENCES");
  } catch {
    bad("VIDEO_SOURCE_REGION_PREFERENCES");
  }
  const gcsProject = env.VIDEO_GCS_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT;
  if (
    (replicate || env.VIDEO_GCS_CDN_DOMAIN) &&
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(gcsProject ?? "")
  )
    bad("VIDEO_GCS_PROJECT_ID");
  const gcsFields = [
    env.VIDEO_GCS_REPLICA_BUCKET,
    env.VIDEO_GCS_CDN_DOMAIN,
    env.VIDEO_GCS_CDN_KEY_NAME,
    env.VIDEO_GCS_CDN_SIGNING_SECRET_ID,
  ];
  const gcsDelivery = gcsFields.slice(1).some(Boolean);
  if (
    gcsDelivery &&
    (mode !== "aws" ||
      gcsFields.some((value) => !value) ||
      !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(gcsFields[0]!) ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(gcsFields[1]!) ||
      !/^[A-Za-z0-9_-]{1,63}$/.test(gcsFields[2]!))
  )
    bad("VIDEO_GCS_CDN");
  if (
    replicate &&
    (mode !== "aws" ||
      !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(
        env.VIDEO_GCS_REPLICA_BUCKET ?? "",
      ))
  )
    bad("VIDEO_GCS_REPLICA_BUCKET");
  if (!["local", "aws"].includes(mode) || (mode === "aws" && driver !== "s3"))
    bad("VIDEO_MODE");
  const maxQuality = Number(env.VIDEO_MAX_QUALITY ?? 2160);
  if (![360, 480, 720, 1080, 1440, 2160].includes(maxQuality))
    bad("VIDEO_MAX_QUALITY");
  const optionalQualities = env.VIDEO_OPTIONAL_QUALITIES
    ? env.VIDEO_OPTIONAL_QUALITIES.split(",").map(Number)
    : [480, 1440];
  if (optionalQualities.some((n) => ![480, 1440].includes(n)))
    bad("VIDEO_OPTIONAL_QUALITIES");
  const config: VideoConfig = {
    mode: mode as VideoConfig["mode"],
    sourceRegionPreferences,
    workerEnabled:
      env.VIDEO_WORKER_ENABLED === "true" ||
      (env.VIDEO_WORKER_ENABLED === undefined && env.VIDEO_MODE === "aws"),
    maxQuality,
    optionalQualities,
    ffmpegPath: env.VIDEO_FFMPEG_PATH ?? localExecutable("ffmpeg"),
    ffprobePath: env.VIDEO_FFPROBE_PATH ?? localExecutable("ffprobe"),
    scratchDirectory: resolve(
      __dirname,
      "../../..",
      env.VIDEO_SCRATCH_DIRECTORY ?? ".local-storage/video-scratch",
    ),
    outputBucket:
      env.VIDEO_OUTPUT_BUCKET ??
      (mode === "aws" ? "streamora-file-storage-output" : ""),
    roleArn:
      env.VIDEO_MEDIACONVERT_ROLE_ARN ??
      (mode === "aws"
        ? `arn:aws:iam::${env.VIDEO_AWS_ACCOUNT_ID ?? ""}:role/streamora-video-mediaconvert`
        : ""),
    queueArn:
      env.VIDEO_MEDIACONVERT_QUEUE_ARN ??
      (mode === "aws"
        ? `arn:aws:mediaconvert:${region}:${env.VIDEO_AWS_ACCOUNT_ID ?? ""}:queues/Default`
        : ""),
    mediaDomain: env.VIDEO_MEDIA_DOMAIN ?? "",
    ...(replicate
      ? {
          replication: {
            bucket: env.VIDEO_GCS_REPLICA_BUCKET!,
            projectId: gcsProject!,
          },
        }
      : {}),
    ...(gcsDelivery
      ? {
          gcsDelivery: {
            bucket: gcsFields[0]!,
            projectId: gcsProject!,
            domain: gcsFields[1]!,
            keyName: gcsFields[2]!,
            signingSecretId: gcsFields[3]!,
          },
        }
      : {}),
    cloudFrontKeyPairId: env.VIDEO_CLOUDFRONT_KEY_PAIR_ID ?? "",
    cloudFrontSigningSecretId: env.VIDEO_CLOUDFRONT_SIGNING_SECRET_ID ?? "",
    tableName:
      env.VIDEO_DYNAMODB_TABLE ??
      (mode === "aws" ? "streamora-video-jobs" : ""),
    accountId: env.VIDEO_AWS_ACCOUNT_ID ?? "",
    region,
  };
  if (
    env.VIDEO_WORKER_ENABLED &&
    !["true", "false"].includes(env.VIDEO_WORKER_ENABLED)
  )
    bad("VIDEO_WORKER_ENABLED");
  // Existing S3 installations can still boot before T13 infrastructure is provisioned.
  // An explicitly selected AWS mode must be fully configured.
  if (env.VIDEO_MODE === "aws") {
    if (!/^\d{12}$/.test(config.accountId)) bad("VIDEO_AWS_ACCOUNT_ID");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.outputBucket))
      bad("VIDEO_OUTPUT_BUCKET");
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(config.tableName))
      bad("VIDEO_DYNAMODB_TABLE");
    if (!/^[a-z0-9.-]+$/.test(config.mediaDomain)) bad("VIDEO_MEDIA_DOMAIN");
    if (!config.roleArn.startsWith(`arn:aws:iam::${config.accountId}:role/`))
      bad("VIDEO_MEDIACONVERT_ROLE_ARN");
    if (
      !config.queueArn.startsWith(
        `arn:aws:mediaconvert:${region}:${config.accountId}:queues/`,
      )
    )
      bad("VIDEO_MEDIACONVERT_QUEUE_ARN");
  }
  if (
    !!config.cloudFrontKeyPairId !== !!config.cloudFrontSigningSecretId ||
    (config.cloudFrontKeyPairId &&
      !/^[A-Z0-9]{8,32}$/.test(config.cloudFrontKeyPairId))
  )
    bad("VIDEO_CLOUDFRONT_KEY_PAIR_ID/VIDEO_CLOUDFRONT_SIGNING_SECRET_ID");
  return config;
}
function localExecutable(name: "ffmpeg" | "ffprobe") {
  // npm ci already installs this production dependency, also in managed-video mode.
  if (name === "ffmpeg") {
    const bundled = require("ffmpeg-static") as string | null;
    if (bundled && existsSync(bundled)) return bundled;
  }
  try {
    return require(
      name === "ffmpeg"
        ? "@ffmpeg-installer/ffmpeg"
        : "@ffprobe-installer/ffprobe",
    ).path as string;
  } catch {
    /* Use the system executable if no bundled binary is installed. */
  }
  return name;
}
