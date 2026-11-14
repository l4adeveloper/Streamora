import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../../database/prisma.service";
import type {
  LibraryFile,
  Prisma,
  VideoJob,
} from "../../generated/prisma/client";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { GroupAccessService } from "../memberships/group-access.service";
import { ApiError } from "../../common/api-error";
import { readSource, type VideoOutput, type VideoSource } from "./video-policy";

export const ACTIVE = ["QUEUED", "SUBMITTING", "PROCESSING", "VERIFYING"];
export function publicState(state: string) {
  return ["SUBMITTING", "VERIFYING"].includes(state) ? "PROCESSING" : state;
}
// Called inside the caller's metadata transaction; never performs storage/queue I/O.
export async function enqueueVideo(
  tx: Prisma.TransactionClient,
  file: LibraryFile,
  encoder: "ffmpeg" | "mediaconvert",
  source?: VideoSource,
) {
  if (
    file.status !== "AVAILABLE" ||
    (!source && !file.mimeType.startsWith("video/"))
  )
    return;
  await tx.$queryRaw`SELECT id FROM files WHERE id=${file.id}::uuid FOR UPDATE`;
  const previous = await tx.videoAsset.findUnique({
    where: { fileId: file.id },
  });
  if (previous) return previous.currentJobId;
  const descriptor = readSource(
    source ?? {
      kind: "FILE",
      storageLocationId: file.storageLocationId,
      key: file.objectKey,
    },
  );
  const job = await tx.videoJob.create({
    data: {
      fileId: file.id,
      mode: descriptor.kind === "HLS" ? "IMPORT_HLS" : "TRANSCODE",
      encoder: descriptor.kind === "HLS" ? "ivs" : encoder,
    },
  });
  await tx.videoAsset.create({
    data: {
      fileId: file.id,
      source: descriptor as unknown as Prisma.InputJsonValue,
      currentJobId: job.id,
    },
  });
  await tx.fileUsage.create({
    data: { fileId: file.id, reference: `video:${job.id}` },
  });
  return job.id;
}
@Injectable()
export class VideoProcessingService {
  constructor(
    readonly db: PrismaService,
    private readonly access: GroupAccessService,
    @Inject(APP_CONFIG) readonly config: EnvironmentConfig,
  ) {}
  async authorize(
    userId: string,
    fileId: string,
    manage = false,
    tx: Prisma.TransactionClient = this.db,
  ) {
    const file = await tx.libraryFile.findUnique({ where: { id: fileId } });
    if (!file || file.status === "DELETED" || file.deletedAt)
      throw new ApiError(404, "FILE_NOT_FOUND", "Không tìm thấy video.");
    const permissions = await this.access.require(
      userId,
      file.groupId,
      manage ? "canHost" : undefined,
      tx,
    );
    if (!file.isPublished && !permissions.canHost && file.createdBy !== userId)
      throw new ApiError(403, "FORBIDDEN", "Video chưa được công bố.");
    return file;
  }
  async recordingFile(recordingId: string) {
    const recording = await this.db.classRecording.findUnique({
      where: { id: recordingId },
    });
    const file = recording?.fileId
      ? await this.db.libraryFile.findUnique({
          where: { id: recording.fileId },
        })
      : await this.db.libraryFile.findUnique({ where: { recordingId } });
    if (!file)
      throw new ApiError(
        404,
        "RECORDING_NOT_FOUND",
        "Không tìm thấy bản ghi đã lưu.",
      );
    return file.id;
  }
  async processing(userId: string, fileId: string) {
    await this.authorize(userId, fileId);
    return this.snapshot(fileId);
  }
  async snapshot(fileId: string, tx: Prisma.TransactionClient = this.db) {
    const asset = await tx.videoAsset.findUnique({ where: { fileId } });
    const job = asset?.currentJobId
      ? await tx.videoJob.findUnique({ where: { id: asset.currentJobId } })
      : null;
    const published = asset?.publishedJobId
      ? await tx.videoJob.findUnique({ where: { id: asset.publishedJobId } })
      : null;
    const output = published?.output as unknown as VideoOutput | undefined;
    return {
      status: (job ? publicState(job.state) : "NOT_REQUESTED") as
        "NOT_REQUESTED" | "QUEUED" | "PROCESSING" | "READY" | "FAILED",
      progressPercent: job?.progressPercent ?? null,
      renditions: (output?.renditions ?? []).map((r) => ({
        height: r.height,
        bitrate: r.bitrate,
        status: "READY" as const,
      })),
      thumbnailReady: !!output?.thumbnailKey,
      ...(job?.errorCode ? { errorCode: job.errorCode } : {}),
    };
  }
  async retry(userId: string, fileId: string, key: string) {
    if (typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new ApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Cần Idempotency-Key hợp lệ.",
      );
    const retryKeyHash = createHash("sha256").update(key).digest("hex");
    return this.db.$transaction(async (tx) => {
      const target = await this.authorize(userId, fileId, true, tx);
      await tx.$queryRaw`SELECT id FROM groups WHERE id=${target.groupId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM files WHERE id=${fileId}::uuid FOR UPDATE`;
      await this.authorize(userId, fileId, true, tx);
      const replay = await tx.videoJob.findUnique({
        where: {
          fileId_retryActor_retryKeyHash: {
            fileId,
            retryActor: userId,
            retryKeyHash,
          },
        },
      });
      if (replay) return { jobId: replay.id, status: "QUEUED" as const };
      const asset = await tx.videoAsset.findUnique({ where: { fileId } });
      const previous = asset?.currentJobId
        ? await tx.videoJob.findUnique({ where: { id: asset.currentJobId } })
        : null;
      if (
        !asset ||
        previous?.state !== "FAILED" ||
        target.status !== "AVAILABLE"
      )
        throw new ApiError(
          409,
          "JOB_NOT_RETRYABLE",
          "Chỉ có thể thử lại video xử lý lỗi.",
        );
      const job = await tx.videoJob.create({
        data: {
          fileId,
          mode: previous.mode,
          encoder: previous.encoder,
          retryKeyHash,
          retryActor: userId,
        },
      });
      await tx.videoAsset.update({
        where: { fileId },
        data: { currentJobId: job.id },
      });
      await tx.fileUsage.create({
        data: { fileId, reference: `video:${job.id}` },
      });
      return { jobId: job.id, status: "QUEUED" as const };
    });
  }
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
