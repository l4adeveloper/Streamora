import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import type { Prisma, VideoJob } from "../../generated/prisma/client";
import { VideoProcessingService, ACTIVE } from "./video-processing.service";
import { VideoStorage } from "./video-storage";
import { FileStorageService } from "../files/file-storage.service";
import {
  makePolicy,
  readSource,
  VideoError,
  type VideoPolicy,
} from "./video-policy";
import { probe, runProcess } from "./video-probe";
import { encodeFfmpeg } from "./ffmpeg-encoder";
import { verifyHls } from "./video-finalizer";
import { prepareScratch } from "./video-scratch";
import {
  MediaConvertEncoder,
  mediaConvertSettings,
} from "./mediaconvert-encoder";
import {
  locationId,
  type StorageTarget,
} from "../files/storage-locations.service";
import type {
  VideoFinalizeMessage,
  VideoFileFinalizeMessage,
} from "@streamora/contracts";

@Injectable()
export class VideoWorker implements OnModuleDestroy {
  private readonly owner = randomUUID();
  private stopped = false;
  private readonly aborts = new Set<AbortController>();
  private sqs?: SQSClient;
  private encoder?: MediaConvertEncoder;
  private running?: Promise<void>;
  private lastRetentionAt = 0;
  private retentionCursor?: string;
  private readonly logger = new Logger(VideoWorker.name);
  constructor(
    readonly service: VideoProcessingService,
    readonly storage: VideoStorage,
    readonly files: FileStorageService,
  ) {}
  get config() {
    const c = this.service.config.video;
    if (!c) throw new VideoError("VIDEO_NOT_CONFIGURED");
    return c;
  }
  async start() {
    await runProcess(this.config.ffprobePath, ["-version"]);
    if (this.config.mode === "local") {
      await runProcess(this.config.ffmpegPath, ["-version"]);
      this.running = this.localLoop();
    } else {
      if (
        !this.config.dispatchQueueUrl ||
        !this.config.completionQueueUrl ||
        !this.config.roleArn ||
        !this.config.accountId
      )
        throw new VideoError("VIDEO_NOT_CONFIGURED");
      this.sqs = new SQSClient({ region: this.config.region, maxAttempts: 2 });
      this.encoder = new MediaConvertEncoder(this.config);
      this.running = Promise.all([
        this.dispatchLoop(),
        this.queueLoop(false),
        this.queueLoop(true),
        this.reconcileLoop(),
      ]).then(() => {});
    }
  }
  private log(code: string) {
    this.logger.warn(JSON.stringify({ event: "video_worker", code }));
  }
  private async localLoop() {
    while (!this.stopped) {
      try {
        if (!(await this.once())) {
          await this.retention();
          await delay(1500);
        }
      } catch {
        this.log("WORKER_RETRY");
        await delay(2000);
      }
    }
  }
  async once(id?: string) {
    const job = await this.service.claim(this.owner, id);
    if (!job) return false;
    await this.process(job);
    return true;
  }
  private async process(job: VideoJob) {
    const abort = new AbortController();
    this.aborts.add(abort);
    let pending: number | undefined,
      busy = false;
    const heartbeat = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.service
        .heartbeat(job, pending)
        .then((ok) => {
          if (!ok) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          busy = false;
        });
    }, 1500);
    let directory: string | undefined;
    let providerComplete = false;
    try {
      if (job.attemptNo > 3) throw new VideoError("ENCODE_FAILED");
      const asset = await this.service.db.videoAsset.findUniqueOrThrow({
        where: { fileId: job.fileId },
      });
      const file = await this.service.db.libraryFile.findUniqueOrThrow({
        where: { id: job.fileId },
      });
      if (file.status !== "AVAILABLE" || file.deletedAt)
        throw new VideoError("SOURCE_MISSING");
      const source = readSource(asset.source);
      if (source.kind === "HLS") {
        const sourceTarget = await this.storage.locations.resolve(
          source.storageLocationId,
        );
        if (
          sourceTarget.driver === "s3" &&
          sourceTarget.bucket !== this.config.outputBucket
        )
          throw new VideoError("VIDEO_DELIVERY_UNAVAILABLE");
        const output = await verifyHls(
          this.storage,
          source.storageLocationId,
          source.prefix,
          source.masterKey,
          undefined,
          source.expectedHeights,
          async (key) =>
            probe(
              this.config.ffprobePath,
              await this.storage.input(source.storageLocationId, key),
              abort.signal,
            ),
        );
        if (!(await this.service.publish(job, output)))
          throw new VideoError("LEASE_LOST");
        return;
      }
      const prefix = `groups/${file.groupId}/videos/${file.id}/${job.id}/${job.attemptNo}`;
      if (
        job.encoder === "mediaconvert" &&
        job.state === "SUBMITTING" &&
        !job.providerJobId
      ) {
        const found = await this.encoder!.reconcile(job.id, job.attemptNo);
        if (!found?.Id) {
          this.log("SUBMISSION_UNCERTAIN");
          await this.release(job, 30000);
          return;
        }
        await this.service.db.videoJob.updateMany({
          where: this.fence(job),
          data: { providerJobId: found.Id, state: "PROCESSING" },
        });
        job.providerJobId = found.Id;
      }
      if (job.encoder === "mediaconvert" && job.providerJobId) {
        const provider = await this.encoder!.inspect(job.providerJobId);
        if (!provider) throw new VideoError("PROVIDER_MISMATCH");
        const sourceTarget = await this.storage.locations.resolve(
          source.storageLocationId,
        );
        if (sourceTarget.driver !== "s3" || !job.policy)
          throw new VideoError("SOURCE_MISSING");
        const policy = job.policy as unknown as VideoPolicy;
        const outputTarget = await this.storage.locations.resolve(
          policy.outputLocationId ?? (await this.outputLocation()),
        );
        if (outputTarget.driver !== "s3")
          throw new VideoError("STORAGE_FAILED");
        this.encoder!.verify(
          provider,
          job.id,
          job.attemptNo,
          `s3://${sourceTarget.bucket}/${source.key}`,
          `s3://${outputTarget.bucket}/${prefix}`,
          policy,
        );
        if (["ERROR", "CANCELED"].includes(provider.Status ?? ""))
          throw new VideoError("ENCODE_FAILED");
        if (provider.Status !== "COMPLETE") {
          if (provider.JobPercentComplete !== undefined)
            await this.service.heartbeat(
              job,
              Math.min(99, provider.JobPercentComplete),
            );
          await this.release(job, 10000);
          return;
        }
        providerComplete = true;
        const location =
          policy.outputLocationId ?? (await this.outputLocation());
        await this.finish(
          job,
          location,
          prefix,
          `${prefix}/hls/master.m3u8`,
          policy,
        );
        return;
      }
      const input = await this.storage.input(
        source.storageLocationId,
        source.key,
      );
      const metadata = await probe(
        this.config.ffprobePath,
        input,
        abort.signal,
      );
      const policy =
        (job.policy as unknown as VideoPolicy | null) ??
        makePolicy(
          metadata,
          this.config.maxQuality,
          this.config.optionalQualities,
        );
      if (job.encoder === "mediaconvert" && !policy.outputLocationId)
        policy.outputLocationId = await this.outputLocation();
      // Bound scratch before launching an encode; source duration and ladder are server-probed.
      if (
        job.encoder === "ffmpeg" &&
        (policy.duration *
          policy.renditions.reduce((n, r) => n + r.bitrate + 128000, 0)) /
          8 >
          8 * 1024 ** 3
      )
        throw new VideoError("SCRATCH_LIMIT_EXCEEDED");
      await this.service.db.videoAsset.update({
        where: { fileId: job.fileId },
        data: { sourceMetadata: metadata as unknown as Prisma.InputJsonValue },
      });
      if (
        !(await this.update(job, {
          policy: policy as unknown as Prisma.InputJsonValue,
        }))
      )
        throw new VideoError("LEASE_LOST");
      if (job.encoder === "mediaconvert") {
        const target = await this.storage.locations.resolve(
          source.storageLocationId,
        );
        if (target.driver !== "s3") throw new VideoError("SOURCE_MISSING");
        if (
          !(await this.update(job, {
            state: "SUBMITTING",
            submittedAt: new Date(),
          }))
        )
          throw new VideoError("LEASE_LOST");
        let providerJobId: string;
        try {
          const outputTarget = await this.storage.locations.resolve(
            policy.outputLocationId!,
          );
          if (outputTarget.driver !== "s3")
            throw new VideoError("STORAGE_FAILED");
          providerJobId = await this.encoder!.submit(
            job.id,
            job.attemptNo,
            mediaConvertSettings(
              `s3://${target.bucket}/${source.key}`,
              `s3://${outputTarget.bucket}/${prefix}`,
              policy,
            ),
          );
        } catch {
          this.log("SUBMISSION_UNCERTAIN");
          await this.release(job, 30000);
          return;
        }
        await this.update(job, { providerJobId, state: "PROCESSING" });
        await this.release(job, 10000);
        return;
      }
      await prepareScratch(
        this.config.scratchDirectory,
        ((policy.duration *
          policy.renditions.reduce((n, r) => n + r.bitrate + 128000, 0)) /
          8) *
          1.2,
      );
      directory = await mkdtemp(
        join(this.config.scratchDirectory, `${job.id}-`),
      );
      await encodeFfmpeg(
        this.config.ffmpegPath,
        input,
        directory,
        policy,
        abort.signal,
        (percent) => {
          pending = percent;
        },
      );
      const copy = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await copy(path);
          else if (entry.isFile()) {
            if (abort.signal.aborted) throw new VideoError("LEASE_LOST");
            await this.files.importLocalFile(
              path,
              `${prefix}/${relative(directory!, path).split(sep).join("/")}`,
              source.storageLocationId,
            );
          }
        }
      };
      await copy(directory);
      await this.finish(
        job,
        source.storageLocationId,
        prefix,
        `${prefix}/hls/master.m3u8`,
        policy,
      );
    } catch (error) {
      const code =
        error instanceof VideoError
          ? error.code
          : (error as { code?: string }).code === "ENOENT"
            ? "SOURCE_MISSING"
            : "STORAGE_FAILED";
      if (code !== "LEASE_LOST") {
        if (
          job.encoder === "mediaconvert" &&
          code === "STORAGE_FAILED" &&
          !providerComplete &&
          (job.providerJobId || job.state === "SUBMITTING")
        ) {
          // A failed status request is not evidence that the provider stopped encoding.
          this.log("PROVIDER_STATUS_UNCERTAIN");
          await this.update(job, { errorCount: { increment: 1 } });
          await this.release(
            job,
            Math.min(60000, 3000 * 2 ** Math.min(job.errorCount, 5)),
          );
          return;
        }
        // Output may be eventually visible or storage temporarily unavailable: bounded verification retry.
        if (
          ["STORAGE_FAILED", "RENDITION_MISSING"].includes(code) &&
          job.errorCount < 2 &&
          job.encoder === "mediaconvert"
        ) {
          await this.update(job, { errorCount: { increment: 1 } });
          await this.release(job, 3000);
        } else await this.service.fail(job, code);
      }
    } finally {
      clearInterval(heartbeat);
      this.aborts.delete(abort);
      if (directory) {
        const root = resolve(this.config.scratchDirectory),
          child = relative(root, resolve(directory));
        if (
          child &&
          child !== ".." &&
          !child.startsWith(`..${sep}`) &&
          !child.includes(":")
        )
          await rm(directory, { recursive: true, force: true });
      }
    }
  }
  private fence(job: VideoJob) {
    return {
      id: job.id,
      attemptNo: job.attemptNo,
      leaseOwner: job.leaseOwner,
      leaseUntil: { gt: new Date() },
      state: { in: ACTIVE },
    };
  }
  private async update(
    job: VideoJob,
    data: Prisma.VideoJobUpdateManyMutationInput,
  ) {
    return (
      (
        await this.service.db.videoJob.updateMany({
          where: this.fence(job),
          data,
        })
      ).count === 1
    );
  }
  private async release(job: VideoJob, ms: number) {
    await this.update(job, {
      leaseOwner: null,
      leaseUntil: null,
      nextRunAt: new Date(Date.now() + ms),
    });
  }
  private async outputLocation() {
    const target: StorageTarget = {
        driver: "s3",
        bucket: this.config.outputBucket,
        region: this.config.region,
      },
      id = locationId(target);
    await this.service.db.storageLocation.upsert({
      where: { id },
      create: { id, driver: "s3", config: target },
      update: {},
    });
    return id;
  }
  private async finish(
    job: VideoJob,
    location: string,
    prefix: string,
    master: string,
    policy: VideoPolicy,
  ) {
    if (!(await this.update(job, { state: "VERIFYING" })))
      throw new VideoError("LEASE_LOST");
    const output = await verifyHls(
      this.storage,
      location,
      prefix,
      master,
      policy,
      undefined,
      async (key) =>
        probe(this.config.ffprobePath, await this.storage.input(location, key)),
    );
    if (!(await this.service.publish(job, output)))
      throw new VideoError("LEASE_LOST");
  }
  private async dispatchLoop() {
    while (!this.stopped) {
      try {
        const jobs = await this.service.db.videoJob.findMany({
          where: {
            state: "QUEUED",
            nextRunAt: { lte: new Date() },
            OR: [
              { lastDispatchAt: null },
              { lastDispatchAt: { lt: new Date(Date.now() - 300000) } },
            ],
          },
          take: 10,
        });
        for (const job of jobs) {
          const file = await this.service.db.libraryFile.findUniqueOrThrow({
            where: { id: job.fileId },
            include: { classRecording: true },
          });
          const recordingId = file.recordingId ?? file.classRecording?.id;
          const body: VideoFinalizeMessage | VideoFileFinalizeMessage =
            recordingId
              ? {
                  jobId: job.id,
                  recordingId,
                  sourceObjectKey: file.objectKey,
                  outputVersion: job.id,
                  requestedAt: job.createdAt.toISOString(),
                }
              : {
                  type: "video.file.finalize.v1",
                  jobId: job.id,
                  fileId: file.id,
                  requestedAt: job.createdAt.toISOString(),
                };
          await this.sqs!.send(
            new SendMessageCommand({
              QueueUrl: this.config.dispatchQueueUrl,
              MessageBody: JSON.stringify(body),
              MessageAttributes: {
                contract: {
                  DataType: "String",
                  StringValue: recordingId
                    ? "video.finalize.v1"
                    : "video.file.finalize.v1",
                },
              },
            }),
          );
          await this.service.db.videoJob.updateMany({
            where: { id: job.id, state: "QUEUED" },
            data: { lastDispatchAt: new Date() },
          });
        }
      } catch {
        this.log("DISPATCH_RETRY");
      }
      await delay(1500);
    }
  }
  private async queueLoop(completion: boolean) {
    const QueueUrl = completion
      ? this.config.completionQueueUrl
      : this.config.dispatchQueueUrl;
    const active = new Set<Promise<void>>();
    while (!this.stopped) {
      try {
        if (active.size >= 4) {
          await Promise.race(active);
          continue;
        }
        const page = await this.sqs!.send(
          new ReceiveMessageCommand({
            QueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 10,
            VisibilityTimeout: 60,
          }),
        );
        for (const message of page.Messages ?? []) {
          const work = this.message(
            QueueUrl,
            message.Body ?? "",
            message.ReceiptHandle!,
            completion,
          ).catch(() => this.log("QUEUE_RETRY"));
          active.add(work);
          void work.finally(() => active.delete(work));
        }
      } catch {
        if (!this.stopped) {
          this.log("QUEUE_RETRY");
          await delay(2000);
        }
      }
    }
    await Promise.allSettled(active);
  }
  private async message(
    QueueUrl: string,
    body: string,
    ReceiptHandle: string,
    completion: boolean,
  ) {
    const data = JSON.parse(body);
    let id: string;
    if (completion) {
      if (
        data.source !== "aws.mediaconvert" ||
        data.account !== this.config.accountId ||
        data.region !== this.config.region ||
        data["detail-type"] !== "MediaConvert Job State Change" ||
        !["COMPLETE", "ERROR", "CANCELED", "STATUS_UPDATE"].includes(
          data.detail?.status,
        )
      )
        throw new VideoError("PROVIDER_MISMATCH");
      const metadata = data.detail.userMetadata;
      if (metadata?.project !== "streamora")
        throw new VideoError("PROVIDER_MISMATCH");
      id = metadata.jobId;
      const row = await this.service.db.videoJob.findUnique({ where: { id } });
      if (
        !row ||
        row.attemptNo !== Number(metadata.attemptNo) ||
        (row.providerJobId && row.providerJobId !== data.detail.jobId)
      )
        throw new VideoError("PROVIDER_MISMATCH");
      if (!row.providerJobId) {
        // Early completion: persist the mapping under a claim after GetJob confirms metadata.
        const provider = await this.encoder!.inspect(data.detail.jobId);
        if (
          provider?.UserMetadata?.jobId !== id ||
          provider.UserMetadata.attemptNo !== metadata.attemptNo ||
          provider.UserMetadata.project !== "streamora"
        )
          throw new VideoError("PROVIDER_MISMATCH");
        await this.service.db.videoJob.updateMany({
          where: { id, state: { in: ACTIVE }, providerJobId: null },
          data: { providerJobId: data.detail.jobId },
        });
      }
      await this.service.db.videoJob.updateMany({
        where: { id, state: { in: ACTIVE } },
        data: { nextRunAt: new Date() },
      });
      await this.once(id);
      const current = await this.service.db.videoJob.findUnique({
        where: { id },
      });
      if (current && ["READY", "FAILED"].includes(current.state))
        await this.sqs!.send(
          new DeleteMessageCommand({ QueueUrl, ReceiptHandle }),
        );
      return;
    }
    id = data.jobId;
    const initial = await this.service.db.videoJob.findUnique({
      where: { id },
      include: { file: { include: { classRecording: true } } },
    });
    if (
      !initial ||
      (data.recordingId
        ? data.recordingId !==
            (initial.file.recordingId ?? initial.file.classRecording?.id) ||
          data.sourceObjectKey !== initial.file.objectKey ||
          data.outputVersion !== id
        : data.type !== "video.file.finalize.v1" ||
          data.fileId !== initial.fileId)
    )
      throw new VideoError("SOURCE_MISSING");
    // Keep the original receipt until READY is durably committed. A failed job goes to the dispatch DLQ.
    for (let tick = 0; !this.stopped && tick < 1000; tick++) {
      const current = await this.service.db.videoJob.findUnique({
        where: { id },
      });
      if (current?.state === "READY") {
        await this.sqs!.send(
          new DeleteMessageCommand({ QueueUrl, ReceiptHandle }),
        );
        return;
      }
      if (!current || current.state === "FAILED") return;
      await this.sqs!.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl,
          ReceiptHandle,
          VisibilityTimeout: 60,
        }),
      );
      await this.once(id);
      await delay(10000);
    }
    // Yield well before SQS's maximum receipt lifetime; redelivery resumes providerJobId.
  }
  private async reconcileLoop() {
    while (!this.stopped) {
      try {
        const jobs = await this.service.db.videoJob.findMany({
          where: {
            state: { in: ["SUBMITTING", "PROCESSING", "VERIFYING"] },
            nextRunAt: { lte: new Date() },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
          },
          take: 4,
        });
        for (const job of jobs) await this.once(job.id);
        await this.retention();
      } catch {
        this.log("RECONCILE_RETRY");
      }
      await delay(5000);
    }
  }
  private async retention() {
    if (Date.now() - this.lastRetentionAt < 300000) return;
    this.lastRetentionAt = Date.now();
    const jobs = await this.service.db.videoJob.findMany({
      where: {
        mode: "TRANSCODE",
        state: { in: ["READY", "FAILED"] },
        updatedAt: { lt: new Date(Date.now() - 7 * 86400000) },
        ...(this.retentionCursor ? { id: { gt: this.retentionCursor } } : {}),
      },
      include: { file: true },
      orderBy: { id: "asc" },
      take: 50,
    });
    if (!jobs.length) {
      this.retentionCursor = undefined;
      return;
    }
    for (const job of jobs) {
      this.retentionCursor = job.id;
      const asset = await this.service.db.videoAsset.findUnique({
        where: { fileId: job.fileId },
      });
      const root = `groups/${job.file.groupId}/videos/${job.fileId}/${job.id}`;
      const prefixes =
        asset?.publishedJobId === job.id && job.file.status !== "DELETED"
          ? Array.from(
              { length: Math.max(0, job.attemptNo - 1) },
              (_, i) => `${root}/${i + 1}`,
            )
          : [root];
      const source = asset ? readSource(asset.source) : undefined;
      const location =
        (job.output as unknown as { storageLocationId?: string })
          ?.storageLocationId ??
        (job.policy as unknown as VideoPolicy)?.outputLocationId ??
        (source?.kind === "FILE" ? source.storageLocationId : undefined);
      for (const prefix of prefixes) {
        const references = await this.service.db.$queryRaw<
          { file_id: string }[]
        >`SELECT file_id FROM video_assets WHERE source->>'kind'='HLS' AND (source->>'prefix'=${prefix} OR starts_with(source->>'prefix',${prefix + "/"}) OR starts_with(${prefix},(source->>'prefix') || '/')) LIMIT 1`;
        if (location && !references.length)
          await this.storage.removePrefix(location, prefix);
      }
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    for (const abort of this.aborts) abort.abort();
    await this.running;
    this.sqs?.destroy();
    this.encoder?.client.destroy();
  }
}
