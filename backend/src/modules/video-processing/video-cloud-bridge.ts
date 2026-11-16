import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnApplicationShutdown,
} from "@nestjs/common";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import type { VideoJob } from "../../generated/prisma/client";
import { StorageLocationsService } from "../files/storage-locations.service";
import { DynamoVideoJobs } from "./dynamodb-video-jobs";
import { ACTIVE } from "./video-job-store";
import { readSource } from "./video-policy";

// SQL holds the file transaction and its durable handoff/pin. Encoding state is
// authoritative in DynamoDB; this relay never probes, encodes or finalizes video.
@Injectable()
export class VideoCloudBridge
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  readonly store?: DynamoVideoJobs;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly logger = new Logger(VideoCloudBridge.name);
  constructor(
    readonly db: PrismaService,
    readonly locations: StorageLocationsService,
    @Inject(APP_CONFIG) readonly config: EnvironmentConfig,
  ) {
    if (config.video?.mode === "aws" && config.video.tableName)
      this.store = new DynamoVideoJobs(
        config.video,
        config.files?.bucket ?? "",
      );
  }
  onApplicationBootstrap() {
    if (!this.store) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 15000);
    this.timer.unref();
    void this.tick();
  }
  async request(fileId: string) {
    if (!this.store) return;
    try {
      await this.deliver(fileId);
    } catch {
      this.logger.warn(
        JSON.stringify({ event: "video_handoff_pending", fileId }),
      );
    }
  }
  async deliver(fileId: string) {
    if (!this.store) return;
    const [file, asset] = await Promise.all([
      this.db.libraryFile.findUnique({ where: { id: fileId } }),
      this.db.videoAsset.findUnique({ where: { fileId } }),
    ]);
    if (
      !file ||
      file.status !== "AVAILABLE" ||
      file.deletedAt ||
      !asset?.currentJobId
    )
      return;
    const [job, published] = await Promise.all([
      this.db.videoJob.findUnique({ where: { id: asset.currentJobId } }),
      asset.publishedJobId
        ? this.db.videoJob.findUnique({ where: { id: asset.publishedJobId } })
        : null,
    ]);
    if (!job || job.encoder === "ffmpeg") return;
    // During cutover, let the previous SQL worker finish or lose its lease before
    // transferring ownership to DynamoDB. The two stores must never run it together.
    if (
      ACTIVE.includes(job.state) &&
      job.leaseOwner &&
      job.leaseUntil &&
      job.leaseUntil.getTime() > Date.now()
    )
      return;
    const source = readSource(asset.source);
    await this.store.ensure(
      job,
      { id: file.id, groupId: file.groupId },
      source,
      await this.locations.resolve(source.storageLocationId),
      published,
    );
    // Register the output identity for API/CDN delivery.
    const id = await this.store.outputLocation(),
      target = await this.store.resolve(id);
    await this.db.storageLocation.upsert({
      where: { id },
      create: { id, driver: target.driver, config: target },
      update: {},
    });
    await this.db.videoJob.updateMany({
      where: { id: job.id, state: { in: ACTIVE } },
      data: {
        lastDispatchAt: new Date(),
        nextRunAt: new Date(Date.now() + 15000),
      },
    });
    const remote = await this.store.job(job.id);
    if (remote && ["READY", "FAILED"].includes(remote.state))
      await this.syncTerminal(remote);
    else this.store.emit("queued");
  }
  async state(fileId: string) {
    if (!this.store) throw new Error("VIDEO_NOT_CONFIGURED");
    return this.store.state(fileId);
  }
  async syncTerminal(job: VideoJob) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM files WHERE id=${job.fileId}::uuid FOR UPDATE`;
      const changed = await tx.videoJob.updateMany({
        where: { id: job.id, state: { in: ACTIVE } },
        data: {
          state: job.state,
          providerJobId: job.providerJobId,
          attemptNo: job.attemptNo,
          policy: job.policy ?? undefined,
          output: job.output ?? undefined,
          progressPercent: job.progressPercent,
          errorCode: job.errorCode,
          leaseOwner: null,
          leaseUntil: null,
        },
      });
      if (!changed.count) return;
      if (job.state === "READY")
        await tx.videoAsset.updateMany({
          where: { fileId: job.fileId, currentJobId: job.id },
          data: { publishedJobId: job.id },
        });
      await tx.fileUsage.deleteMany({
        where: { fileId: job.fileId, reference: `video:${job.id}` },
      });
    });
  }
  async tick() {
    if (!this.store || this.running) return this.running;
    this.running = (async () => {
      const jobs = await this.db.videoJob.findMany({
        where: {
          encoder: { in: ["mediaconvert", "ivs"] },
          state: { in: ACTIVE },
          nextRunAt: { lte: new Date() },
          file: { storageLocation: { driver: "s3" } },
        },
        orderBy: { nextRunAt: "asc" },
        take: 20,
      });
      for (const job of jobs) await this.request(job.fileId);
    })().catch(() => {
      this.logger.warn("VIDEO_HANDOFF_RETRY");
    });
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  async deleted(fileId: string) {
    await this.store?.deleted(fileId);
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  onApplicationShutdown() {
    // Nest finishes worker destruction before application shutdown hooks.
    this.store?.close();
  }
}
