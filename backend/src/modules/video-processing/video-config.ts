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
