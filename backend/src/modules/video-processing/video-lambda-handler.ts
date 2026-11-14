import { VideoError } from "./video-policy";
import type { VideoConfig } from "./video-config";
import type { VideoWorker } from "./video-worker";

export interface VideoLambdaContext {
  callbackWaitsForEmptyEventLoop: boolean;
  getRemainingTimeInMillis(): number;
}
interface QueueRecord {
  messageId: string;
  body: string;
  eventSource: string;
  eventSourceARN: string;
}
type VideoLambdaEvent = { Records?: QueueRecord[]; action?: string };

function queueArn(url: string) {
  const parsed = new URL(url);
  const [account, name] = parsed.pathname.slice(1).split("/");
  return `arn:aws:sqs:${parsed.hostname.split(".")[1]}:${account}:${name}`;
}

// No polling or waiting for an encode. SQS deletes only records this invocation accepts.
export function createVideoLambdaHandler(
  config: VideoConfig,
  getWorker: () => Promise<Pick<VideoWorker, "handleMessage" | "maintenance">>,
) {
  const dispatch = queueArn(config.dispatchQueueUrl);
  const completion = queueArn(config.completionQueueUrl);
  return async (event: VideoLambdaEvent, context: VideoLambdaContext) => {
    context.callbackWaitsForEmptyEventLoop = false; // Reuse the small DB pool on warm invocations.
    if (event.action === "maintenance" && !event.Records) {
      try {
        await (
          await getWorker()
        ).maintenance(() => context.getRemainingTimeInMillis());
      } catch {
        throw new VideoError("VIDEO_MAINTENANCE_FAILED");
      }
      return { ok: true };
    }
    if (!Array.isArray(event.Records) || !event.Records.length)
      throw new VideoError("VIDEO_EVENT_INVALID");
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        if (context.getRemainingTimeInMillis() < 30000)
          throw new VideoError("VIDEO_TIME_BUDGET");
        if (
          record.eventSource !== "aws:sqs" ||
          ![dispatch, completion].includes(record.eventSourceARN)
        )
          throw new VideoError("VIDEO_QUEUE_MISMATCH");
        await (
          await getWorker()
        ).handleMessage(record.body, record.eventSourceARN === completion);
      } catch (error) {
        // Provider/DB errors may contain signed URLs or passwords; log only our safe code.
        console.warn(
          JSON.stringify({
            event: "video_lambda",
            code:
              error instanceof VideoError ? error.code : "VIDEO_LAMBDA_FAILED",
          }),
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
