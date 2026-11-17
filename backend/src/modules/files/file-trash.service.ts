import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { isUUID } from "class-validator";
import { randomUUID } from "node:crypto";
import type { FileTrashListResponse } from "@streamora/contracts";
import type { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { ApiError } from "../../common/api-error";
import { safeErrorCode } from "../../common/safe-error-code";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import type { LibraryFile, Prisma } from "../../generated/prisma/client";
import { GroupAccessService } from "../memberships/group-access.service";
import { presentFile } from "./file-presenter";
import { FileStorageService } from "./file-storage.service";
import { FileTrashStorage, trashFailureDetails } from "./file-trash-storage";

function trashUnavailable() {
  return new ApiError(
    503,
    "TRASH_UNAVAILABLE",
    "Thùng rác Google Cloud chưa được cấu hình.",
  );
}

@Injectable()
export class FileTrashService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private abort?: AbortController;
  private stopping = false;
  private readonly storage: FileTrashStorage;

  constructor(
    private readonly db: PrismaService,
    private readonly access: GroupAccessService,
    private readonly files: FileStorageService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {
    this.storage = new FileTrashStorage(files, config.files?.trash?.projectId);
  }

  async enqueue(
    tx: Prisma.TransactionClient,
    file: LibraryFile,
    required: boolean,
  ) {
    const trash = this.config.files?.trash;
    const target = await this.files.locations.resolve(file.storageLocationId);
    if (!trash && (required || (target.driver === "s3" && target.bucket)))
      throw trashUnavailable();
    if (trash) {
      if (target.driver !== "s3")
        throw new ApiError(
          409,
          "TRASH_REQUIRES_S3",
          "Chỉ các tài liệu lưu trên S3 có thể chuyển vào thùng rác.",
        );
      if (file.mimeType === "application/vnd.apple.mpegurl")
        throw new ApiError(
          409,
          "FILE_IN_USE",
          "Không thể chuyển nguồn phát HLS vào thùng rác.",
        );
    }
    await tx.fileObjectDeletion.create({
      data: {
        fileId: file.id,
        objectKey: file.objectKey,
        storageLocationId: file.storageLocationId,
        ...(trash
          ? {
              trashBucket: trash.bucket,
              trashKey: `trash/${file.groupId}/${file.id}/${randomUUID()}`,
              trashPhase: "ARCHIVING",
              // Exclude trash from permanent cleanup even during a rolling upgrade.
              completedAt: new Date(),
            }
          : {}),
      },
    });
    return !!trash;
  }

  async list(
    userId: string,
    groupId: string,
    query: PaginationQueryDto,
  ): Promise<FileTrashListResponse> {
    const permissions = await this.access.require(userId, groupId);
    let after: { id: string; at: Date } | undefined;
    if (query.cursor) {
      try {
        const cursor = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString("utf8"),
        );
        const at = new Date(cursor.at);
        if (
          cursor.groupId !== groupId ||
          !isUUID(cursor.id) ||
          at.toISOString() !== cursor.at
        )
          throw new Error();
        after = { id: cursor.id, at };
      } catch {
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "Phân trang không hợp lệ. Hãy tải lại danh sách.",
        );
      }
    }
    const rows = await this.db.libraryFile.findMany({
      where: {
        groupId,
        status: "DELETED",
        deletedAt: { not: null },
        deletion: { is: { trashPhase: { not: null } } },
        ...(!permissions.canHost ? { createdBy: userId } : {}),
        ...(after
          ? {
              OR: [
                { deletedAt: { lt: after.at } },
                { deletedAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      include: {
        deletion: {
          select: {
            trashPhase: true,
            trashProgressPercent: true,
            attempts: true,
            leaseOwner: true,
          },
        },
        folder: { select: { name: true } },
      },
      orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((file) => {
        const deletion = file.deletion!;
        const phase = deletion.trashPhase;
        return {
          ...presentFile(file),
          deletedAt: file.deletedAt!.toISOString(),
          trashStatus:
            phase === "TRASHED"
              ? "TRASHED"
              : phase === "RESTORING" || phase === "RESTORED"
                ? "RESTORING"
                : "ARCHIVING",
          progressPercent:
            phase === "TRASHED"
              ? 100
              : phase === "ARCHIVED" || phase === "RESTORED"
                ? 99
                : deletion.trashProgressPercent,
          retrying: deletion.attempts > 0 && deletion.leaseOwner === null,
        };
      }),
      nextCursor:
        last && rows.length > query.limit
          ? Buffer.from(
              JSON.stringify({ groupId, id: last.id, at: last.deletedAt }),
            ).toString("base64url")
          : null,
    };
  }

  async requestRestore(userId: string, groupId: string, fileId: string) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM groups WHERE id = ${groupId}::uuid FOR UPDATE`;
      const permissions = await this.access.require(
        userId,
        groupId,
        undefined,
        tx,
      );
      const file = await tx.libraryFile.findFirst({
        where: { id: fileId, groupId, status: "DELETED" },
        include: { deletion: true },
      });
      if (
        !file?.deletion?.trashPhase ||
        (!permissions.canHost && file.createdBy !== userId)
      )
        throw new ApiError(
          404,
          "FILE_NOT_FOUND",
          "Không tìm thấy tài liệu trong thùng rác.",
        );
      if (!this.config.files?.trash) throw trashUnavailable();
      const phase = file.deletion.trashPhase;
      if (phase === "RESTORING" || phase === "RESTORED") return;
      if (phase !== "TRASHED")
        throw new ApiError(
          409,
          "TRASH_NOT_READY",
          "Tài liệu đang được chuyển vào thùng rác.",
        );
      await tx.fileObjectDeletion.updateMany({
        where: { fileId, trashPhase: "TRASHED" },
        data: {
          trashPhase: "RESTORING",
          trashProgressPercent: 0,
          nextAttemptAt: new Date(),
          attempts: 0,
        },
      });
    });
  }

  onModuleInit() {
    if (!this.config.files?.trash) return;
    this.timer = setInterval(() => void this.tick(), 3000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.abort?.abort();
    await this.running;
  }

  tick() {
    if (!this.running)
      this.running = this.process()
        .catch((error) => {
          console.warn(
            JSON.stringify({
              event: "file_trash_worker_error",
              code: safeErrorCode(error),
            }),
          );
        })
        .finally(() => {
          this.running = undefined;
        });
    return this.running;
  }

  private async process() {
    const owner = randomUUID();
    const [claim] = await this.db.$queryRaw<Array<{ file_id: string }>>`
      UPDATE file_object_deletions
        SET lease_owner = ${owner}::uuid, attempts = attempts + 1,
          trash_progress_percent = CASE WHEN trash_phase IN ('ARCHIVING', 'RESTORING')
            THEN 0 ELSE trash_progress_percent END,
          next_attempt_at = now() + interval '2 minutes'
        WHERE file_id = (SELECT file_id FROM file_object_deletions
          WHERE trash_phase IN ('ARCHIVING', 'ARCHIVED', 'RESTORING', 'RESTORED')
            AND next_attempt_at <= now()
          ORDER BY next_attempt_at, file_id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING file_id`;
    if (!claim) return;
    const fileId = claim.file_id;
    const job = await this.db.fileObjectDeletion.findFirst({
      where: { fileId, leaseOwner: owner },
      include: { file: { select: { size: true } } },
    });
    if (!job?.trashBucket || !job.trashKey || this.stopping) return;
    const object = {
      ...job,
      trashBucket: job.trashBucket,
      trashKey: job.trashKey,
      size: job.file.size,
    };
    const owned = () => ({
      fileId,
      leaseOwner: owner,
      nextAttemptAt: { gt: new Date() },
    });
    const advance = (data: Prisma.FileObjectDeletionUpdateManyMutationInput) =>
      this.db.fileObjectDeletion.updateMany({
        where: owned(),
        data: {
          ...data,
          leaseOwner: null,
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      });
    const abort = (this.abort = new AbortController());
    const copying =
      job.trashPhase === "ARCHIVING" || job.trashPhase === "RESTORING";
    let progressWrite: Promise<void> | undefined;
    let lastProgress = 0;
    let nextProgressUpdate = 0;
    const reportProgress = (bytes: number, total: number) => {
      if (abort.signal.aborted || !Number.isFinite(bytes) || total <= 0) return;
      const percent = Math.min(99, Math.floor((bytes / total) * 100));
      const now = Date.now();
      if (percent <= lastProgress || progressWrite || now < nextProgressUpdate)
        return;
      lastProgress = percent;
      nextProgressUpdate = now + 1000;
      progressWrite = this.db.fileObjectDeletion
        .updateMany({
          where: owned(),
          data: { trashProgressPercent: percent },
        })
        // A progress write must not fail a healthy stream.
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          progressWrite = undefined;
        });
    };
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.db.fileObjectDeletion
        .updateMany({
          where: owned(),
          data: { nextAttemptAt: new Date(Date.now() + 120_000) },
        })
        .then(({ count }) => {
          if (!count) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          renewal = undefined;
        });
    }, 30_000);
    heartbeat.unref();
    try {
      if (job.trashPhase === "ARCHIVING") {
        const { generation, etag } = await this.storage.archive(
          object,
          abort.signal,
          reportProgress,
        );
        abort.signal.throwIfAborted();
        await advance({
          trashPhase: "ARCHIVED",
          trashProgressPercent: 99,
          trashGeneration: generation,
          sourceEtag: etag,
        });
      } else if (
        job.trashPhase === "ARCHIVED" &&
        job.sourceEtag &&
        job.trashGeneration
      ) {
        await this.storage.removeOriginal(
          object,
          job.sourceEtag,
          job.trashGeneration,
          abort.signal,
        );
        await advance({ trashPhase: "TRASHED", trashProgressPercent: 100 });
      } else if (job.trashPhase === "RESTORING" && job.trashGeneration) {
        await this.storage.restore(
          object,
          job.trashGeneration,
          abort.signal,
          reportProgress,
        );
        abort.signal.throwIfAborted();
        await advance({ trashPhase: "RESTORED", trashProgressPercent: 99 });
      } else if (job.trashPhase === "RESTORED" && job.trashGeneration) {
        await this.storage.removeArchive(object, job.trashGeneration);
        await this.db.$transaction(async (tx) => {
          const removed = await tx.fileObjectDeletion.deleteMany({
            where: owned(),
          });
          if (!removed.count) return;
          const file = await tx.libraryFile.update({
            where: { id: fileId },
            data: { status: "AVAILABLE", deletedAt: null },
            select: { classRecording: { select: { id: true } } },
          });
          await tx.storageReplica.updateMany({
            where: {
              errorCode: "REPLICA_SOURCE_INVALID",
              OR: [
                { kind: "RAW", assetId: fileId },
                ...(file.classRecording
                  ? [{ kind: "LIVE_DVR", assetId: file.classRecording.id }]
                  : []),
              ],
            },
            data: {
              status: "PENDING",
              completed: false,
              attempts: 0,
              nextRunAt: new Date(),
              errorCode: null,
            },
          });
        });
      } else {
        throw new Error("TRASH_STATE_INVALID");
      }
    } catch (error) {
      const backoff = Math.min(
        3_600_000,
        15_000 * 2 ** Math.min(job.attempts - 1, 8),
      );
      await this.db.fileObjectDeletion.updateMany({
        where: owned(),
        data: {
          leaseOwner: null,
          nextAttemptAt: new Date(Date.now() + backoff),
          ...(copying ? { trashProgressPercent: 0 } : {}),
        },
      });
      console.warn(
        JSON.stringify({
          event: "file_trash_retry",
          fileId,
          phase: job.trashPhase,
          ...trashFailureDetails(error),
        }),
      );
    } finally {
      clearInterval(heartbeat);
      await Promise.all([renewal, progressWrite]);
      this.abort = undefined;
    }
  }
}
