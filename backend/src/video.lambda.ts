import "reflect-metadata";
import { readVideoConfig } from "./modules/video-processing/video-config";
import { DynamoVideoJobs } from "./modules/video-processing/dynamodb-video-jobs";
import { VideoStorage } from "./modules/video-processing/video-storage";
import { VideoWorker } from "./modules/video-processing/video-worker";
import { MediaConvertEncoder } from "./modules/video-processing/mediaconvert-encoder";
import { VideoError } from "./modules/video-processing/video-policy";

export function readVideoLambdaConfig(env: NodeJS.ProcessEnv) {
  const region = env.FILES_S3_REGION ?? "ap-northeast-1";
  const sourceBucket = env.FILES_S3_BUCKET ?? "streamora-file-storage";
  if (
    (env.VIDEO_MODE ?? "aws") !== "aws" ||
    !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(sourceBucket)
  )
    throw new VideoError("VIDEO_NOT_CONFIGURED");
  return {
    video: readVideoConfig(
      { ...env, VIDEO_MODE: "aws" },
      "s3",
      region,
      "lambda",
    ),
    sourceBucket,
  };
}
interface Runtime {
  store: DynamoVideoJobs;
  worker: Pick<VideoWorker, "once">;
  storage: Pick<VideoStorage, "removePrefix">;
}
interface Context {
  callbackWaitsForEmptyEventLoop?: boolean;
  getRemainingTimeInMillis(): number;
}

export function createVideoLambdaHandler(
  config: ReturnType<typeof readVideoLambdaConfig>,
  getRuntime: () => Runtime,
) {
  return async (event: any, context: Context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    if (event?.action !== "maintenance")
      throw new VideoError("VIDEO_EVENT_INVALID");
    const { store, worker, storage } = getRuntime();
    const remaining = () => context.getRemainingTimeInMillis();
    for (const job of await store.due()) {
      if (remaining() < 60000) break;
      try {
        await worker.once(job.id);
      } catch {
        // Leave persisted jobs due for a later tick; one failed job must not block the batch.
        console.warn(
          JSON.stringify({ event: "video_job_retry", code: "VIDEO_JOB_RETRY" }),
        );
      }
    }
    if (remaining() >= 60000)
      await store.cleanup(
        (location, prefix) => storage.removePrefix(location, prefix),
        remaining,
      );
    return { ok: true };
  };
}

let runtime: Runtime | undefined;
export async function handler(event: unknown, context: Context) {
  const config = readVideoLambdaConfig(process.env);
  return createVideoLambdaHandler(config, () => {
    if (!runtime) {
      const store = new DynamoVideoJobs(config.video, config.sourceBucket);
      const storage = new VideoStorage(store);
      runtime = {
        store,
        storage,
        worker: new VideoWorker(
          store,
          storage,
          undefined,
          new MediaConvertEncoder(config.video),
        ),
      };
    }
    return runtime;
  })(event, context);
}
