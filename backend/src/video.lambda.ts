import "reflect-metadata";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import type { PrismaService } from "./database/prisma.service";
import { readVideoConfig } from "./modules/video-processing/video-config";
import { VideoJobsService } from "./modules/video-processing/video-jobs.service";
import { VideoStorage } from "./modules/video-processing/video-storage";
import { StorageLocationsService } from "./modules/files/storage-locations.service";
import { VideoWorker } from "./modules/video-processing/video-worker";
import { VideoError } from "./modules/video-processing/video-policy";
import {
  createVideoLambdaHandler,
  type VideoLambdaContext,
} from "./modules/video-processing/video-lambda-handler";

export function readVideoLambdaConfig(env: NodeJS.ProcessEnv) {
  if (env.VIDEO_MODE !== "aws" || env.VIDEO_WORKER_ENABLED === "true")
    throw new VideoError("VIDEO_LAMBDA_CONFIG_INVALID");
  const region = env.FILES_S3_REGION ?? env.AWS_REGION ?? "ap-northeast-1";
  const video = readVideoConfig(env, "s3", region, "lambda");
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.FILES_S3_BUCKET ?? "") ||
    !env.VIDEO_DATABASE_SECRET_ARN?.startsWith(
      `arn:aws:secretsmanager:${region}:${video.accountId}:secret:`,
    )
  )
    throw new VideoError("VIDEO_LAMBDA_CONFIG_INVALID");
  return {
    video,
    databaseSecretArn: env.VIDEO_DATABASE_SECRET_ARN,
    files: {
      driver: "s3" as const,
      bucket: env.FILES_S3_BUCKET!,
      region,
      downloadTtlSeconds: 60,
      cleanupEnabled: false,
    },
  };
}

let runtime: Promise<{ worker: VideoWorker; db: PrismaClient }> | undefined;
let expiresAt = 0;

async function getRuntime(config: ReturnType<typeof readVideoLambdaConfig>) {
  if (runtime && Date.now() >= expiresAt) {
    const previous = await runtime;
    await previous.worker.onModuleDestroy();
    await previous.db.$disconnect();
    runtime = undefined;
  }
  if (!runtime) {
    expiresAt = Date.now() + 300000;
    runtime = (async () => {
      const secrets = new SecretsManagerClient({ region: config.video.region });
      let url: string;
      try {
        const result = await secrets.send(
          new GetSecretValueCommand({ SecretId: config.databaseSecretArn }),
        );
        url = JSON.parse(result.SecretString ?? "{}").url;
        if (typeof url !== "string" || !/^postgres(?:ql)?:\/\//.test(url))
          throw new Error();
      } catch {
        throw new VideoError("VIDEO_DATABASE_SECRET_UNAVAILABLE");
      } finally {
        secrets.destroy();
      }
      return createVideoRuntime(config, url);
    })().catch((error) => {
      runtime = undefined;
      throw error;
    });
  }
  return runtime;
}

// Explicit constructor also permits an isolated DB smoke test of the packaged ZIP.
export function createVideoRuntime(
  config: ReturnType<typeof readVideoLambdaConfig>,
  url: string,
) {
  const db = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 5000,
      query_timeout: 15000,
      statement_timeout: 12000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
    }),
    errorFormat: "minimal",
    log: [],
  });
  const database = db as PrismaService;
  const jobs = new VideoJobsService(database, { video: config.video });
  const locations = new StorageLocationsService(
    { files: config.files },
    database,
  );
  return { db, worker: new VideoWorker(jobs, new VideoStorage(locations)) };
}

// No Nest HTTP application, authentication keys, FFmpeg or migrations in Lambda.
export async function handler(
  event: Parameters<ReturnType<typeof createVideoLambdaHandler>>[0],
  context: VideoLambdaContext,
) {
  const config = readVideoLambdaConfig(process.env);
  return createVideoLambdaHandler(
    config.video,
    async () => (await getRuntime(config)).worker,
  )(event, context);
}
