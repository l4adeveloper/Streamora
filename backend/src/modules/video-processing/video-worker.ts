import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { Prisma, VideoJob } from "../../generated/prisma/client";
import { VideoJobsService, ACTIVE } from "./video-jobs.service";
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
export class VideoWorker implements OnApplicationBootstrap, OnModuleDestroy {
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
    readonly service: VideoJobsService,
    readonly storage: VideoStorage,
    @Optional() readonly files?: FileStorageService,
  ) {}
  get config() {
    const c = this.service.config.video;
    if (!c) throw new VideoError("VIDEO_NOT_CONFIGURED");
    return c;
  }
  async onApplicationBootstrap() {
    if (this.service.config.video?.workerEnabled) await this.start();
  }
  async start() {
    if (this.running) return;
    if (this.config.mode === "local") {
      await runProcess(this.config.ffprobePath, ["-version"]);
      await runProcess(this.config.ffmpegPath, ["-version"]);
      this.running = this.localLoop();
    } else throw new VideoError("AWS_VIDEO_REQUIRES_LAMBDA");
  }
  private cloud() {
    if (this.config.mode !== "aws")
      throw new VideoError("VIDEO_NOT_CONFIGURED");
    this.sqs ??= new SQSClient({ region: this.config.region, maxAttempts: 2 });
    this.encoder ??= new MediaConvertEncoder(this.config);
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
    if (this.config.mode === "aws") this.cloud();
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
    let heartbeatWork: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (busy) return;
      busy = true;
      heartbeatWork = this.service
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
          (key) =>
            this.inspectMedia(source.storageLocationId, key, abort.signal),
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
      const metadata = await this.inspectMedia(
        source.storageLocationId,
        source.key,
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
        } catch (error) {
          const status = (error as { $metadata?: { httpStatusCode?: number } })
            .$metadata?.httpStatusCode;
          if (
            status &&
            status >= 400 &&
            status < 500 &&
            ![408, 429].includes(status)
          )
            throw new VideoError(
              status === 403 ? "PROVIDER_ACCESS_DENIED" : "ENCODE_FAILED",
            );
          this.log("SUBMISSION_UNCERTAIN");
          await this.release(job, 30000);
          return;
        }
        await this.update(job, { providerJobId, state: "PROCESSING" });
        await this.release(job, 10000);
        return;
      }
      const input = await this.storage.input(
        source.storageLocationId,
        source.key,
      );
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
            await this.files!.importLocalFile(
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
      await heartbeatWork;
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
  private async inspectMedia(
    location: string,
    key: string,
    signal?: AbortSignal,
  ) {
    const input = await this.storage.input(location, key);
    if (signal?.aborted) throw new VideoError("LEASE_LOST");
    return this.config.mode === "aws"
      ? this.encoder!.probe(input)
      : probe(this.config.ffprobePath, input, signal);
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
      (key) => this.inspectMedia(location, key),
    );
    if (!(await this.service.publish(job, output)))
      throw new VideoError("LEASE_LOST");
  }
  async dispatch() {
    this.cloud();
    const jobs = await this.service.db.videoJob.findMany({
      where: {
        state: "QUEUED",
        encoder: { in: ["mediaconvert", "ivs"] },
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
      const body: VideoFinalizeMessage | VideoFileFinalizeMessage = recordingId
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
  }
  async handleMessage(body: string, completion: boolean) {
    this.cloud();
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
      if (!row) throw new VideoError("PROVIDER_MISMATCH");
      if (
        row.attemptNo !== Number(metadata.attemptNo) ||
        ["READY", "FAILED"].includes(row.state)
      )
        return;
      if (row.providerJobId && row.providerJobId !== data.detail.jobId)
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
      if (
        ["COMPLETE", "ERROR", "CANCELED"].includes(data.detail.status) &&
        (!current || !["READY", "FAILED"].includes(current.state))
      )
        throw new VideoError("VIDEO_COMPLETION_PENDING");
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
    if (["READY", "FAILED"].includes(initial.state)) return;
    if (initial.encoder === "ffmpeg")
      throw new VideoError("VIDEO_SOURCE_NOT_CLOUD");
    await this.once(id);
    const current = await this.service.db.videoJob.findUnique({
      where: { id },
    });
    // Dispatch is a short submission command. Its durable DB state is the handoff
    // to completion/reconcile, rather than keeping a Lambda alive during encoding.
    if (
      !current ||
      !(
        ["READY", "FAILED", "SUBMITTING"].includes(current.state) ||
        current.providerJobId
      )
    )
      throw new VideoError("VIDEO_DISPATCH_PENDING");
  }
  async maintenance(remaining: () => number = () => Infinity) {
    this.cloud();
    await this.dispatch();
    const jobs = await this.service.db.videoJob.findMany({
      where: {
        encoder: { in: ["mediaconvert", "ivs"] },
        state: { in: ["SUBMITTING", "PROCESSING", "VERIFYING"] },
        nextRunAt: { lte: new Date() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      orderBy: { nextRunAt: "asc" },
      take: 4,
    });
    for (const job of jobs) {
      if (remaining() < 60000) break;
      await this.once(job.id);
    }
    if (remaining() >= 60000) await this.retention(remaining);
  }
  private async retention(remaining: () => number = () => Infinity) {
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
      if (remaining() < 30000) break;
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
