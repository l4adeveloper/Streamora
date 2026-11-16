import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import { IvsService } from "../class-media/ivs.service";
import { FileStorageService } from "../files/file-storage.service";
import {
  enqueueVideo,
  VideoProcessingService,
} from "../video-processing/video-processing.service";
import { objectKey } from "../video-processing/video-policy";
import {
  exportRecording,
  recordingKey,
  recordingText,
} from "./recording-export";
import { recordingChanged } from "./screen-share-policy";

/** SQL-backed polling: no SQS, EventBridge or browser heartbeat is required. */
@Injectable()
export class CloudRecordingWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CloudRecordingWorker.name);
  private readonly shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private readonly pending = new Set<Promise<unknown>>();
  private exporting = false;
  constructor(
    private readonly db: PrismaService,
    private readonly ivs: IvsService,
    private readonly storage: FileStorageService,
    private readonly processing: VideoProcessingService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}
  onApplicationBootstrap() {
    if (!this.config.ivs?.enabled) return;
    this.timer = setInterval(() => this.wake(), 10000);
    this.timer.unref();
    this.wake();
  }
  wake(id?: string) {
    if (this.shutdown.signal.aborted) return;
    const work = this.tick(id).catch(() =>
      this.logger.warn("Không thể kiểm tra bản ghi IVS; sẽ thử lại."),
    );
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
  async tick(id?: string) {
    const rows = await this.db.classRecording.findMany({
      where: {
        ...(id ? { id } : {}),
        provider: "IVS",
        status: { in: ["RECORDING", "SAVING"] },
        nextCheckAt: { lte: new Date() },
        OR: [
          { workerLeaseUntil: null },
          { workerLeaseUntil: { lt: new Date() } },
        ],
      },
      orderBy: { nextCheckAt: "asc" },
      take: 20,
    });
    await Promise.allSettled(rows.map((row) => this.check(row.id)));
  }
  private async check(id: string) {
    const owner = randomUUID();
    const owned = {
      id,
      workerLeaseOwner: owner,
      workerLeaseUntil: { gt: new Date() },
    };
    const claim = await this.db.classRecording.updateMany({
      where: {
        id,
        status: { in: ["RECORDING", "SAVING"] },
        OR: [
          { workerLeaseUntil: null },
          { workerLeaseUntil: { lt: new Date() } },
        ],
      },
      data: {
        workerLeaseOwner: owner,
        workerLeaseUntil: new Date(Date.now() + 120000),
      },
    });
    if (!claim.count) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
    const lease = setInterval(() => {
      void this.db.classRecording
        .updateMany({
          where: {
            id,
            workerLeaseOwner: owner,
            workerLeaseUntil: { gt: new Date() },
          },
          data: { workerLeaseUntil: new Date(Date.now() + 120000) },
        })
        .then(({ count }) => {
          if (!count) controller.abort();
        })
        .catch(() => controller.abort());
    }, 15000);
    let directory: string | undefined;
    let exporting = false;
    let retryDelay = 10000;
    try {
      let row = await this.db.classRecording.findUniqueOrThrow({
        where: { id },
        include: { session: true },
      });
      if (!row.stageArn || !row.storageLocationId)
        throw new Error("RECORDING_SOURCE_MISSING");
      if (!row.compositionArn) {
        const stopped =
          row.status === "SAVING" || row.session.status !== "LIVE";
        const recovered = stopped
          ? await this.ivs.findRecording(row.stageArn, row.id)
          : null;
        if (stopped && !recovered) {
          await this.fail(id, owner, "RECORDING_NOT_STARTED");
          return;
        }
        const target = await this.storage.locations.resolve(
          row.storageLocationId,
        );
        if (
          target.driver !== "s3" ||
          target.bucket !== (await this.ivs.recordingBucket())
        )
          throw new Error("RECORDING_BUCKET_MISMATCH");
        const composition =
          recovered ?? (await this.ivs.startRecording(row.stageArn, row.id));
        const prefix = composition?.destinations?.find((d) => d.detail?.s3)
          ?.detail?.s3?.recordingPrefix;
        if (!composition?.arn || !prefix)
          throw new Error("RECORDING_RESPONSE_INVALID");
        objectKey(prefix);
        await this.db.classRecording.updateMany({
          where: owned,
          data: {
            compositionArn: composition.arn,
            recordingPrefix: prefix,
            errorCode: null,
          },
        });
        row = await this.db.classRecording.findUniqueOrThrow({
          where: { id },
          include: { session: true },
        });
      }
      if (signal.aborted) return;
      if (row.status === "SAVING" || row.session.status !== "LIVE") {
        await this.ivs.stopRecording(row.compositionArn!);
        await this.saving(id);
      }
      const composition = await this.ivs.recording(row.compositionArn!);
      if (
        composition &&
        !["STOPPED", "FAILED"].includes(composition.state ?? "")
      )
        return;
      await this.saving(id);
      // GetComposition disappears shortly after stopping; the S3 end marker is durable.
      const prefix = row.recordingPrefix!;
      let metadata;
      try {
        metadata = JSON.parse(
          await recordingText(
            this.storage,
            row.storageLocationId!,
            prefix + "/events/recording-ended.json",
          ),
        );
      } catch (error) {
        if (!["NoSuchKey", "NotFound"].includes((error as Error).name))
          throw error;
        try {
          metadata = JSON.parse(
            await recordingText(
              this.storage,
              row.storageLocationId!,
              prefix + "/events/recording-failed.json",
            ),
          );
        } catch (missing) {
          if (!["NoSuchKey", "NotFound"].includes((missing as Error).name))
            throw missing;
          // The composition may have stopped before IVS could write any output.
          if (
            Date.now() - (row.stoppedAt ?? new Date()).getTime() >
            10 * 60_000
          )
            await this.fail(id, owner, "RECORDING_OUTPUT_MISSING");
          return;
        }
      }
      if (metadata.stage_arn !== row.stageArn)
        throw new Error("RECORDING_SOURCE_MISMATCH");
      const hls = metadata.media?.hls;
      if (!hls || !Number.isFinite(hls.duration_ms) || hls.duration_ms <= 0) {
        await this.fail(id, owner, "RECORDING_EMPTY");
        return;
      }
      if (this.exporting) return;
      this.exporting = exporting = true;
      const master = recordingKey(
        prefix,
        prefix + "/index",
        `${hls.path}/${hls.playlist}`,
      );
      directory = await mkdtemp(join(tmpdir(), "streamora-recording-"));
      const output = await exportRecording(
        this.storage,
        row.storageLocationId!,
        prefix,
        master,
        directory,
        this.config.video?.ffmpegPath ?? "ffmpeg",
        signal,
      );
      signal.throwIfAborted();
      const fileId = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM class_recordings WHERE id=${id}::uuid FOR UPDATE`;
        const current = await tx.classRecording.findUniqueOrThrow({
          where: { id },
        });
        if (current.fileId) return current.fileId;
        if (
          current.workerLeaseOwner !== owner ||
          !current.workerLeaseUntil ||
          current.workerLeaseUntil <= new Date()
        )
          throw new Error("RECORDING_LEASE_LOST");
        const file = await tx.libraryFile.create({
          data: {
            groupId: row.session.groupId!,
            sessionId: row.sessionId,
            createdBy: row.recorderId,
            name: `${row.session.title} - ${row.startedAt.toISOString().replace(/[:.]/g, "-")}.mp4`.slice(
              -255,
            ),
            objectKey: output.key,
            storageLocationId: row.storageLocationId,
            size: BigInt(output.size),
            mimeType: "video/mp4",
            source: "CLOUD_RECORDING",
            status: "AVAILABLE",
          },
        });
        await tx.classRecording.update({
          where: { id },
          data: {
            fileId: file.id,
            status: "SAVED",
            stoppedAt: current.stoppedAt ?? new Date(),
            errorCode: null,
            version: { increment: 1 },
          },
        });
        // Neither job exists before IVS has finalized the recording on S3.
        await enqueueVideo(
          tx,
          file,
          this.config.video?.mode === "aws" ? "mediaconvert" : "ffmpeg",
        );
        await tx.videoTranscript.create({ data: { fileId: file.id } });
        await recordingChanged(tx, row.sessionId);
        return file.id;
      });
      await this.processing.queueCommitted(fileId);
    } catch (error) {
      if (!signal.aborted) {
        const code = /^[A-Z][A-Z_]{1,63}$/.test((error as Error).message ?? "")
          ? (error as Error).message
          : "RECORDING_SYNC_PENDING";
        retryDelay =
          code === "RECORDING_EXPORT_TOO_LARGE" ? 60 * 60_000 : 60_000;
        await this.db.classRecording.updateMany({
          where: { id, workerLeaseOwner: owner },
          data: { errorCode: code },
        });
        // Retry storage/network/export errors. The original HLS is never deleted.
        this.logger.warn(
          `Bản ghi ${id}: ${code}; sẽ thử lại từ dữ liệu trên S3.`,
        );
      }
    } finally {
      clearInterval(lease);
      if (
        directory &&
        dirname(directory) === resolve(tmpdir()) &&
        basename(directory).startsWith("streamora-recording-")
      )
        await rm(directory, { recursive: true, force: true });
      if (exporting) this.exporting = false;
      await this.db.classRecording.updateMany({
        where: { id, workerLeaseOwner: owner },
        data: {
          workerLeaseOwner: null,
          workerLeaseUntil: null,
          nextCheckAt: new Date(Date.now() + retryDelay),
        },
      });
    }
  }
  private async saving(id: string) {
    await this.db.$transaction(async (tx) => {
      const result = await tx.classRecording.updateMany({
        where: { id, status: "RECORDING" },
        data: {
          status: "SAVING",
          stoppedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (result.count) {
        const row = await tx.classRecording.findUniqueOrThrow({
          where: { id },
        });
        await recordingChanged(tx, row.sessionId);
      }
    });
  }
  private async fail(id: string, owner: string, errorCode: string) {
    await this.db.$transaction(async (tx) => {
      const result = await tx.classRecording.updateMany({
        where: { id, workerLeaseOwner: owner, fileId: null },
        data: {
          status: "FAILED",
          errorCode,
          stoppedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (result.count) {
        const row = await tx.classRecording.findUniqueOrThrow({
          where: { id },
        });
        await recordingChanged(tx, row.sessionId);
      }
    });
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}
