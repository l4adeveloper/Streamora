import { resolve } from "node:path";
export interface VideoConfig {
  mode: "local" | "aws";
  maxQuality: number;
  optionalQualities: number[];
  ffmpegPath: string;
  ffprobePath: string;
  scratchDirectory: string;
  dispatchQueueUrl: string;
  completionQueueUrl: string;
  outputBucket: string;
  roleArn: string;
  queueArn: string;
  mediaDomain: string;
  signingSecretArn: string;
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
  const maxQuality = Number(env.VIDEO_MAX_QUALITY ?? 1080);
  if (![360, 480, 720, 1080, 1440, 2160].includes(maxQuality))
    bad("VIDEO_MAX_QUALITY");
  const optionalQualities = env.VIDEO_OPTIONAL_QUALITIES
    ? env.VIDEO_OPTIONAL_QUALITIES.split(",").map(Number)
    : [];
  if (optionalQualities.some((n) => ![480, 1440].includes(n)))
    bad("VIDEO_OPTIONAL_QUALITIES");
  const config: VideoConfig = {
    mode: mode as VideoConfig["mode"],
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
    dispatchQueueUrl: env.VIDEO_DISPATCH_QUEUE_URL ?? "",
    completionQueueUrl: env.VIDEO_COMPLETION_QUEUE_URL ?? "",
    outputBucket: env.VIDEO_OUTPUT_BUCKET ?? "",
    roleArn: env.VIDEO_MEDIACONVERT_ROLE_ARN ?? "",
    queueArn: env.VIDEO_MEDIACONVERT_QUEUE_ARN ?? "",
    mediaDomain: env.VIDEO_MEDIA_DOMAIN ?? "",
    signingSecretArn: env.VIDEO_SIGNING_SECRET_ARN ?? "",
    accountId: env.VIDEO_AWS_ACCOUNT_ID ?? "",
    region,
  };
  // Existing S3 installations can still boot before T13 infrastructure is provisioned.
  // An explicitly selected AWS mode must be fully configured.
  if (env.VIDEO_MODE === "aws") {
    for (const [key, value] of Object.entries({
      VIDEO_OUTPUT_BUCKET: config.outputBucket,
      VIDEO_MEDIACONVERT_ROLE_ARN: config.roleArn,
      VIDEO_MEDIACONVERT_QUEUE_ARN: config.queueArn,
      VIDEO_SIGNING_SECRET_ARN: config.signingSecretArn,
    }))
      if (!value) bad(key);
    if (!/^\d{12}$/.test(config.accountId)) bad("VIDEO_AWS_ACCOUNT_ID");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.outputBucket))
      bad("VIDEO_OUTPUT_BUCKET");
    if (!config.roleArn.startsWith(`arn:aws:iam::${config.accountId}:role/`))
      bad("VIDEO_MEDIACONVERT_ROLE_ARN");
    if (
      !config.queueArn.startsWith(
        `arn:aws:mediaconvert:${region}:${config.accountId}:queues/`,
      )
    )
      bad("VIDEO_MEDIACONVERT_QUEUE_ARN");
    if (
      !config.signingSecretArn.startsWith(
        `arn:aws:secretsmanager:${region}:${config.accountId}:secret:`,
      )
    )
      bad("VIDEO_SIGNING_SECRET_ARN");
    if (!/^[a-z0-9.-]+$/.test(config.mediaDomain)) bad("VIDEO_MEDIA_DOMAIN");
    for (const [key, value] of [
      ["VIDEO_DISPATCH_QUEUE_URL", config.dispatchQueueUrl],
      ["VIDEO_COMPLETION_QUEUE_URL", config.completionQueueUrl],
    ]) {
      try {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.hostname !== `sqs.${region}.amazonaws.com` ||
          !new RegExp(`^/${config.accountId}/[\\w-]+$`).test(url.pathname) ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          bad(key);
      } catch {
        bad(key);
      }
    }
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
