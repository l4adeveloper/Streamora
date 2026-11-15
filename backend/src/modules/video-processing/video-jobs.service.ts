import { EventEmitter } from "node:events";
import type { PrismaService } from "../../database/prisma.service";
import { Prisma, type VideoJob } from "../../generated/prisma/client";
import type { EnvironmentConfig } from "../../config/environment";
import {
  VideoError,
  type SourceMetadata,
  type VideoOutput,
} from "./video-policy";
import { ACTIVE } from "./video-job-store";

// Local job execution; AWS uses this SQL data only for durable metadata handoff.
export class VideoJobsService extends EventEmitter {
  constructor(
    readonly db: PrismaService,
    readonly config: Pick<EnvironmentConfig, "video">,
  ) {
    super();
  }
  notifyQueued() {
    this.emit("queued");
  }
  async load(job: VideoJob) {
    const [file, asset] = await Promise.all([
      this.db.libraryFile.findUniqueOrThrow({ where: { id: job.fileId } }),
      this.db.videoAsset.findUniqueOrThrow({ where: { fileId: job.fileId } }),
    ]);
    return { file, asset };
  }
  saveMetadata(job: VideoJob, metadata: SourceMetadata) {
    return this.db.videoAsset.update({
      where: { fileId: job.fileId },
      data: { sourceMetadata: metadata as unknown as Prisma.InputJsonValue },
    });
  }
  async outputLocation(): Promise<string> {
    throw new VideoError("VIDEO_SOURCE_NOT_CLOUD");
  }
  async update(job: VideoJob, data: Prisma.VideoJobUpdateManyMutationInput) {
    return (
      (
        await this.db.videoJob.updateMany({
          where: {
            id: job.id,
            attemptNo: job.attemptNo,
            leaseOwner: job.leaseOwner,
            leaseUntil: { gt: new Date() },
            state: { in: ACTIVE },
          },
          data,
        })
      ).count === 1
    );
  }
  async claim(owner: string, id?: string): Promise<VideoJob | null> {
    if (this.config.video?.mode === "aws") return null;
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM video_jobs
        WHERE state IN ('QUEUED','SUBMITTING','PROCESSING','VERIFYING')
          AND encoder IN ('ivs','ffmpeg')
          AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now())
          ${id ? Prisma.sql`AND id=${id}::uuid` : Prisma.empty}
        ORDER BY CASE WHEN state='QUEUED' THEN 1 ELSE 0 END, next_run_at, created_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      `);
      if (!rows[0]) return null;
      const job = (await tx.videoJob.findUnique({
        where: { id: rows[0].id },
      }))!;
      return tx.videoJob.update({
        where: { id: job.id },
        data: {
          leaseOwner: owner,
          leaseUntil: new Date(Date.now() + 30000),
          attemptNo: { increment: 1 },
          state: "PROCESSING",
          deliveryCount: { increment: 1 },
        },
      });
    });
  }
  async heartbeat(job: VideoJob, progressPercent?: number) {
    return this.update(job, {
      leaseUntil: new Date(Date.now() + 30000),
      ...(progressPercent !== undefined ? { progressPercent } : {}),
    });
  }
  async publish(job: VideoJob, output: VideoOutput) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM files WHERE id=${job.fileId}::uuid FOR UPDATE`;
      const file = await tx.libraryFile.findUnique({
        where: { id: job.fileId },
      });
      const asset = await tx.videoAsset.findUnique({
        where: { fileId: job.fileId },
      });
      if (
        !file ||
        file.status !== "AVAILABLE" ||
        file.deletedAt ||
        asset?.currentJobId !== job.id
      )
        return false;
      const result = await tx.videoJob.updateMany({
        where: {
          id: job.id,
          attemptNo: job.attemptNo,
          leaseOwner: job.leaseOwner,
          leaseUntil: { gt: new Date() },
          state: { in: ACTIVE },
        },
        data: {
          state: "READY",
          progressPercent: 100,
          output: output as unknown as Prisma.InputJsonValue,
          leaseOwner: null,
          leaseUntil: null,
          errorCode: null,
        },
      });
      if (!result.count) return false;
      await tx.videoAsset.update({
        where: { fileId: job.fileId },
        data: { publishedJobId: job.id },
      });
      await tx.fileUsage.deleteMany({
        where: { fileId: job.fileId, reference: `video:${job.id}` },
      });
      return true;
    });
  }
  async fail(job: VideoJob, code: string) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM files WHERE id=${job.fileId}::uuid FOR UPDATE`;
      const changed = await tx.videoJob.updateMany({
        where: {
          id: job.id,
          attemptNo: job.attemptNo,
          leaseOwner: job.leaseOwner,
          leaseUntil: { gt: new Date() },
          state: { in: ACTIVE },
        },
        data: {
          state: "FAILED",
          errorCode: code,
          leaseOwner: null,
          leaseUntil: null,
          errorCount: { increment: 1 },
        },
      });
      if (changed.count)
        await tx.fileUsage.deleteMany({
          where: { fileId: job.fileId, reference: `video:${job.id}` },
        });
    });
  }
}
