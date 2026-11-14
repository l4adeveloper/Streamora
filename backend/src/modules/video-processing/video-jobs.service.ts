import type { PrismaService } from "../../database/prisma.service";
import type { Prisma, VideoJob } from "../../generated/prisma/client";
import type { EnvironmentConfig } from "../../config/environment";
import type { VideoOutput } from "./video-policy";

export const ACTIVE = ["QUEUED", "SUBMITTING", "PROCESSING", "VERIFYING"];

// Database state machine shared by the API and Lambda; no HTTP/auth startup.
export class VideoJobsService {
  constructor(
    readonly db: PrismaService,
    readonly config: Pick<EnvironmentConfig, "video">,
  ) {}
  async claim(owner: string, id?: string): Promise<VideoJob | null> {
    return this.db.$transaction(async (tx) => {
      const rows = id
        ? await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM video_jobs WHERE id=${id}::uuid AND state IN ('QUEUED','SUBMITTING','PROCESSING','VERIFYING') AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now()) FOR UPDATE SKIP LOCKED LIMIT 1`
        : await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM video_jobs WHERE state IN ('QUEUED','SUBMITTING','PROCESSING','VERIFYING') AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows[0]) return null;
      const job = (await tx.videoJob.findUnique({
        where: { id: rows[0].id },
      }))!;
      if (job.encoder === "mediaconvert" && job.state === "QUEUED") {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(713013)`;
        const inFlight = await tx.videoJob.count({
          where: {
            encoder: "mediaconvert",
            state: { in: ["SUBMITTING", "PROCESSING", "VERIFYING"] },
          },
        });
        if (inFlight >= 4) return null;
      }
      // AWS SUBMITTING is an uncertain handoff. Never advance its attempt or resubmit blindly.
      const resume = job.encoder === "mediaconvert" && job.state !== "QUEUED";
      return tx.videoJob.update({
        where: { id: job.id },
        data: {
          leaseOwner: owner,
          leaseUntil: new Date(Date.now() + 30000),
          attemptNo: resume ? job.attemptNo : { increment: 1 },
          state: resume ? job.state : "PROCESSING",
          deliveryCount: { increment: 1 },
        },
      });
    });
  }
  async heartbeat(job: VideoJob, progressPercent?: number) {
    const result = await this.db.videoJob.updateMany({
      where: {
        id: job.id,
        attemptNo: job.attemptNo,
        leaseOwner: job.leaseOwner,
        leaseUntil: { gt: new Date() },
        state: { in: ACTIVE },
      },
      data: {
        leaseUntil: new Date(Date.now() + 30000),
        ...(progressPercent !== undefined ? { progressPercent } : {}),
      },
    });
    return result.count === 1;
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
