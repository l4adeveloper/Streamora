import { Inject, Injectable, Optional } from "@nestjs/common";
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

import { VideoCloudBridge } from "./video-cloud-bridge";
import { VideoJobsService } from "./video-jobs.service";
function publicState(state: string) {
  return ["SUBMITTING", "VERIFYING"].includes(state) ? "PROCESSING" : state;
}
export function processingSnapshot(
  job: VideoJob | null,
  published: VideoJob | null,
) {
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
export class VideoProcessingService extends VideoJobsService {
  constructor(
    db: PrismaService,
    private readonly access: GroupAccessService,
    @Inject(APP_CONFIG) config: EnvironmentConfig,
    @Optional() readonly cloud?: VideoCloudBridge,
  ) {
    super(db, config);
  }
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
    const { job, published } = await this.state(fileId, tx);
    return processingSnapshot(job, published);
  }
  async state(fileId: string, tx: Prisma.TransactionClient = this.db) {
    if (this.cloud?.store) {
      const remote = await this.cloud.state(fileId);
      if (remote.asset) return remote;
    }
    const asset = await tx.videoAsset.findUnique({ where: { fileId } });
    const job = asset?.currentJobId
      ? await tx.videoJob.findUnique({ where: { id: asset.currentJobId } })
      : null;
    const published = asset?.publishedJobId
      ? await tx.videoJob.findUnique({ where: { id: asset.publishedJobId } })
      : null;
    return { asset: asset ?? undefined, job, published };
  }
  async queueCommitted(fileId: string) {
    this.notifyQueued();
    await this.cloud?.request(fileId);
  }
  async cloudDeleted(fileId: string) {
    await this.cloud?.deleted(fileId);
  }
  async retry(userId: string, fileId: string, key: string, reprocess = false) {
    if (typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new ApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Cần Idempotency-Key hợp lệ.",
      );
    if (this.cloud?.store) {
      await this.authorize(userId, fileId, true);
      await this.cloud.deliver(fileId);
    }
    const retryKeyHash = createHash("sha256").update(key).digest("hex");
    const result = await this.db.$transaction(async (tx) => {
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
        target.status !== "AVAILABLE" ||
        (!reprocess && (!asset || previous?.state !== "FAILED")) ||
        (!asset &&
          (!target.mimeType.startsWith("video/") || !target.storageLocationId))
      )
        throw new ApiError(
          409,
          "JOB_NOT_RETRYABLE",
          "Video chưa sẵn sàng để xử lý.",
        );
      // Concurrent clicks share the running job; published output stays usable.
      if (previous && !["READY", "FAILED"].includes(previous.state))
        return { jobId: previous.id, status: "QUEUED" as const };
      const source = readSource(
        asset?.source ?? {
          kind: "FILE",
          key: target.objectKey,
          storageLocationId: target.storageLocationId,
        },
      );
      const job = await tx.videoJob.create({
        data: {
          fileId,
          mode: source.kind === "HLS" ? "IMPORT_HLS" : "TRANSCODE",
          encoder:
            source.kind === "HLS"
              ? "ivs"
              : this.config.video?.mode === "aws"
                ? "mediaconvert"
                : "ffmpeg",
          retryKeyHash,
          retryActor: userId,
        },
      });
      await tx.videoAsset.upsert({
        where: { fileId },
        update: { currentJobId: job.id },
        create: {
          fileId,
          currentJobId: job.id,
          source: source as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.fileUsage.create({
        data: { fileId, reference: `video:${job.id}` },
      });
      return { jobId: job.id, status: "QUEUED" as const };
    });
    await this.queueCommitted(fileId);
    return result;
  }
}
