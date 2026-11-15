import "reflect-metadata";
import { readVideoConfig } from "./modules/video-processing/video-config";
import { DynamoVideoJobs } from "./modules/video-processing/dynamodb-video-jobs";
import { VideoStorage } from "./modules/video-processing/video-storage";
import { VideoWorker } from "./modules/video-processing/video-worker";
import { MediaConvertEncoder } from "./modules/video-processing/mediaconvert-encoder";
import { ACTIVE } from "./modules/video-processing/video-job-store";
import { VideoError } from "./modules/video-processing/video-policy";

export function readVideoLambdaConfig(env: NodeJS.ProcessEnv) {
  const region = env.FILES_S3_REGION ?? "";
  const sourceBucket = env.FILES_S3_BUCKET ?? "";
  if (
    env.VIDEO_MODE !== "aws" ||
    !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(sourceBucket)
  )
    throw new VideoError("VIDEO_NOT_CONFIGURED");
  return { video: readVideoConfig(env, "s3", region, "lambda"), sourceBucket };
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
    const { store, worker, storage } = getRuntime();
    const remaining = () => context.getRemainingTimeInMillis();
    if (Array.isArray(event?.Records)) {
      const batchItemFailures: { itemIdentifier: string }[] = [];
      for (const record of event.Records) {
        const sequence = record.dynamodb?.SequenceNumber ?? record.eventID;
        try {
          if (remaining() < 45000) throw new VideoError("VIDEO_TIME_BUDGET");
          const prefix = `arn:aws:dynamodb:${config.video.region}:${config.video.accountId}:table/${config.video.tableName}/stream/`;
          if (
            record.eventSource !== "aws:dynamodb" ||
            !record.eventSourceARN?.startsWith(prefix)
          )
            throw new VideoError("VIDEO_EVENT_INVALID");
          const image = record.dynamodb?.NewImage;
          if (
            record.eventName !== "INSERT" ||
            image?.kind?.S !== "JOB" ||
            !ACTIVE.includes(image.state?.S)
          )
            continue;
          if (typeof image.id?.S !== "string" || !image.id.S)
            throw new VideoError("VIDEO_EVENT_INVALID");
          await worker.once(image.id.S);
        } catch {
          console.warn(
            JSON.stringify({
              event: "video_stream_retry",
              code: "VIDEO_EVENT_RETRY",
            }),
          );
          if (!sequence) throw new VideoError("VIDEO_EVENT_INVALID");
          batchItemFailures.push({ itemIdentifier: sequence });
        }
      }
      return { batchItemFailures };
    }
    if (event?.action === "maintenance") {
      for (const job of await store.due()) {
        if (remaining() < 60000) break;
        await worker.once(job.id);
      }
      if (remaining() >= 60000)
        await store.cleanup(
          (location, prefix) => storage.removePrefix(location, prefix),
          remaining,
        );
      return { ok: true };
    }
    if (
      event?.source !== "aws.mediaconvert" ||
      event.account !== config.video.accountId ||
      event.region !== config.video.region ||
      event["detail-type"] !== "MediaConvert Job State Change" ||
      !["COMPLETE", "ERROR", "CANCELED", "STATUS_UPDATE"].includes(
        event.detail?.status,
      ) ||
      event.detail.userMetadata?.project !== "streamora"
    )
      throw new VideoError("VIDEO_EVENT_INVALID");
    const metadata = event.detail.userMetadata;
    if (
      typeof metadata.jobId !== "string" ||
      typeof event.detail.jobId !== "string"
    )
      throw new VideoError("VIDEO_EVENT_INVALID");
    const job = await store.job(metadata.jobId);
    if (!job) throw new VideoError("PROVIDER_MISMATCH");
    if (
      job.attemptNo !== Number(metadata.attemptNo) ||
      ["READY", "FAILED"].includes(job.state)
    )
      return { ok: true };
    if (job.providerJobId && job.providerJobId !== event.detail.jobId)
      throw new VideoError("PROVIDER_MISMATCH");
    await store.expedite(job.id, job.attemptNo, event.detail.jobId);
    await worker.once(job.id);
    const current = await store.job(job.id);
    if (
      event.detail.status !== "STATUS_UPDATE" &&
      (!current || !["READY", "FAILED"].includes(current.state))
    )
      throw new VideoError("VIDEO_COMPLETION_PENDING");
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
