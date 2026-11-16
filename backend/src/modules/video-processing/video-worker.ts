import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Prisma, VideoJob } from "../../generated/prisma/client";
import type { VideoJobStore } from "./video-job-store";
import { VideoStorage } from "./video-storage";
import type { FileStorageService } from "../files/file-storage.service";
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
import type { ManagedVideoEncoder } from "./managed-video-encoder";

@Injectable()
export class VideoWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly owner = randomUUID();
  private stopped = false;
  private readonly aborts = new Set<AbortController>();
  private idle?: () => void;
  private queued = false;
  private readonly wake = () => {
    this.queued = true;
    this.idle?.();
  };
  private encoder?: ManagedVideoEncoder;
  private running?: Promise<void>;
  private lastRetentionAt = 0;
  private retentionCursor?: string;
  private readonly logger = new Logger(VideoWorker.name);
  constructor(
    readonly service: VideoJobStore,
    readonly storage: VideoStorage,
    readonly files?: FileStorageService,
    readonly managedEncoder?: ManagedVideoEncoder,
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
    } else this.cloud();
    this.stopped = false;
    this.service.on("queued", this.wake);
    this.running = this.loop();
  }
  private cloud() {
    if (this.config.mode !== "aws")
      throw new VideoError("VIDEO_NOT_CONFIGURED");
    this.encoder ??= this.managedEncoder;
    if (!this.encoder) throw new VideoError("VIDEO_NOT_CONFIGURED");
  }
  private log(code: string) {
    this.logger.warn(JSON.stringify({ event: "video_worker", code }));
  }
  private async wait(ms: number) {
    if (this.stopped || this.queued) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idle = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.idle = done;
    });
  }
  private async loop() {
    while (!this.stopped) {
      this.queued = false;
      try {
        if (!(await this.once())) {
          await this.retention();
          await this.wait(1500);
        }
      } catch {
        this.log("WORKER_RETRY");
        await this.wait(2000);
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
      const { file, asset } = await this.service.load(job);
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
        const found = await this.encoder!.recover(job.id, job.attemptNo);
        if (!found) {
          this.log("SUBMISSION_UNCERTAIN");
          await this.release(job, 30000);
          return;
        }
        if (
          !(await this.service.update(job, {
            providerJobId: found,
            state: "PROCESSING",
          }))
        )
          throw new VideoError("LEASE_LOST");
        job.providerJobId = found;
      }
      if (job.encoder === "mediaconvert" && job.providerJobId) {
        const sourceTarget = await this.storage.locations.resolve(
          source.storageLocationId,
        );
        if (sourceTarget.driver !== "s3" || !job.policy)
          throw new VideoError("SOURCE_MISSING");
        const policy = job.policy as unknown as VideoPolicy;
        const outputTarget = await this.storage.locations.resolve(
          policy.outputLocationId ?? (await this.service.outputLocation()),
        );
        if (outputTarget.driver !== "s3")
          throw new VideoError("STORAGE_FAILED");
        const provider = await this.encoder!.status(job.providerJobId, {
          jobId: job.id,
          attempt: job.attemptNo,
          source: `s3://${sourceTarget.bucket}/${source.key}`,
          destination: `s3://${outputTarget.bucket}/${prefix}`,
          policy,
        });
        if (provider.state === "FAILED") throw new VideoError("ENCODE_FAILED");
        if (provider.state !== "COMPLETE") {
          if (provider.progressPercent !== undefined)
            await this.service.heartbeat(
              job,
              Math.min(99, provider.progressPercent),
            );
          await this.release(job, 10000);
          return;
        }
        providerComplete = true;
        const location =
          policy.outputLocationId ?? (await this.service.outputLocation());
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
        policy.outputLocationId = await this.service.outputLocation();
      // Bound scratch before launching an encode; source duration and ladder are server-probed.
      if (
        job.encoder === "ffmpeg" &&
        (policy.duration *
          policy.renditions.reduce((n, r) => n + r.bitrate + 128000, 0)) /
          8 >
          8 * 1024 ** 3
      )
        throw new VideoError("SCRATCH_LIMIT_EXCEEDED");
      await this.service.saveMetadata(job, metadata);
      if (
        !(await this.service.update(job, {
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
          !(await this.service.update(job, {
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
          providerJobId = await this.encoder!.start({
            jobId: job.id,
            attempt: job.attemptNo,
            source: `s3://${target.bucket}/${source.key}`,
            destination: `s3://${outputTarget.bucket}/${prefix}`,
            policy,
          });
        } catch (error) {
          if (
            error instanceof VideoError &&
            error.code !== "SUBMISSION_UNCERTAIN"
          )
            throw error;
          this.log("SUBMISSION_UNCERTAIN");
          await this.release(job, 30000);
          return;
        }
        await this.service.update(job, { providerJobId, state: "PROCESSING" });
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
            const key = `${prefix}/${relative(directory!, path).split(sep).join("/")}`;
            await this.files!.writeFile(
              path,
              key,
              key.endsWith(".m3u8")
                ? "application/vnd.apple.mpegurl"
                : key.endsWith(".ts") ? "video/mp2t" : "image/jpeg",
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
          await this.service.update(job, { errorCount: { increment: 1 } });
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
          await this.service.update(job, { errorCount: { increment: 1 } });
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
  private async release(job: VideoJob, ms: number) {
    await this.service.update(job, {
      leaseOwner: null,
      leaseUntil: null,
      nextRunAt: new Date(Date.now() + ms),
    });
  }
  private async finish(
    job: VideoJob,
    location: string,
    prefix: string,
    master: string,
    policy: VideoPolicy,
  ) {
    if (!(await this.service.update(job, { state: "VERIFYING" })))
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
  private async retention() {
    if (Date.now() - this.lastRetentionAt < 300000) return;
    this.lastRetentionAt = Date.now();
    if (this.service.cleanup) {
      const until = Date.now() + 60000;
      await this.service.cleanup(
        (location, prefix) => this.storage.removePrefix(location, prefix),
        () => (this.stopped ? 0 : until - Date.now()),
      );
      return;
    }
    const db = this.service.db;
    if (!db) return;
    const jobs = await db.videoJob.findMany({
      where: {
        mode: "TRANSCODE",
        encoder: "ffmpeg",
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
      const asset = await db.videoAsset.findUnique({
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
        const references = await db.$queryRaw<
          { file_id: string }[]
        >`SELECT file_id FROM video_assets WHERE source->>'kind'='HLS' AND (source->>'prefix'=${prefix} OR starts_with(source->>'prefix',${prefix + "/"}) OR starts_with(${prefix},(source->>'prefix') || '/')) LIMIT 1`;
        if (location && !references.length)
          await this.storage.removePrefix(location, prefix);
      }
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.service.off("queued", this.wake);
    this.idle?.();
    for (const abort of this.aborts) abort.abort();
    await this.running;
    (this.encoder ?? this.managedEncoder)?.close();
  }
}
