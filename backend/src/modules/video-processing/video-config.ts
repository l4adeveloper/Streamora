import { resolve } from "node:path";
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
    !["local", "aws"].includes(mode) ||
    (mode === "local" && driver !== "local") ||
    (mode === "aws" && driver !== "s3")
  )
    bad("VIDEO_MODE");
  const maxQuality = Number(env.VIDEO_MAX_QUALITY ?? 2160);
  if (![360, 480, 720, 1080, 1440, 2160].includes(maxQuality))
    bad("VIDEO_MAX_QUALITY");
  const optionalQualities = env.VIDEO_OPTIONAL_QUALITIES
    ? env.VIDEO_OPTIONAL_QUALITIES.split(",").map(Number)
    : [];
  if (optionalQualities.some((n) => ![480, 1440].includes(n)))
    bad("VIDEO_OPTIONAL_QUALITIES");
  const config: VideoConfig = {
    mode: mode as VideoConfig["mode"],
    workerEnabled:
      env.VIDEO_WORKER_ENABLED === "true" ||
      (env.VIDEO_WORKER_ENABLED === undefined && env.VIDEO_MODE === "aws"),
    maxQuality,
    optionalQualities,
    ffmpegPath:
      env.VIDEO_FFMPEG_PATH ?? localExecutable("ffmpeg", env.NODE_ENV),
    ffprobePath:
      env.VIDEO_FFPROBE_PATH ?? localExecutable("ffprobe", env.NODE_ENV),
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
  return config;
}
function localExecutable(name: "ffmpeg" | "ffprobe", nodeEnv?: string) {
  if (nodeEnv !== "production") {
    try {
      return require(
        name === "ffmpeg"
          ? "@ffmpeg-installer/ffmpeg"
          : "@ffprobe-installer/ffprobe",
      ).path as string;
    } catch {
      /* System executable in production/minimal installs. */
    }
  }
  return name;
}
