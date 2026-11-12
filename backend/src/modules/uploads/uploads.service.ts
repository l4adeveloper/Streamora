import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import type { Prisma, UploadSession } from "../../generated/prisma/client";
import { GroupAccessService } from "../memberships/group-access.service";
import { FileStorageService } from "../files/file-storage.service";
import { presentFile } from "../files/file-presenter";
import { ApiError } from "../../common/api-error";
import { safeErrorCode } from "../../common/safe-error-code";
import { MultipartStorageService } from "./multipart-storage.service";
import type { CreateUploadDto, CompleteUploadDto } from "./uploads.dto";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/webm",
  "audio/mpeg",
  "audio/ogg",
  "video/webm",
  "video/mp4",
  "video/quicktime",
]);
const IN_PROGRESS = ["INITIALIZING", "ACTIVE", "COMPLETING", "ABORTING"];
const LEASE_MS = 5 * 60 * 1000;
function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
function busy(): never {
  return fail(
    409,
    "UPLOAD_BUSY",
    "Phiên tải lên đang được xử lý. Hãy thử lại sau.",
  );
}

@Injectable()
export class UploadsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private cleanup?: Promise<{
    scanned: number;
    aborted: number;
    failed: number;
  }>;
  constructor(
    private readonly db: PrismaService,
    private readonly access: GroupAccessService,
    private readonly storage: MultipartStorageService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
    private readonly files: FileStorageService,
  ) {}

  async create(userId: string, dto: CreateUploadDto) {
    const policy: NonNullable<EnvironmentConfig["uploads"]> = this.config
      .uploads ?? {
      maxSize: 2 * 1024 ** 3,
      partSize: 8 * 1024 ** 2,
      ttlSeconds: 86400,
      localPort: 4002,
    };
    if (dto.size > policy.maxSize)
      fail(413, "FILE_TOO_LARGE", "File vượt quá kích thước cho phép.");
    if (
      !ALLOWED_TYPES.has(dto.mimeType) ||
      (dto.source === "LOCAL_RECORDING" &&
        !/^(video|audio)\//.test(dto.mimeType))
    )
      fail(415, "UNSUPPORTED_TYPE", "Loại file chưa được hỗ trợ.");
    if (dto.source === "LOCAL_RECORDING" && !dto.sessionId)
      fail(400, "SESSION_REQUIRED", "Bản ghi cần buổi học tương ứng.");
    const id = randomUUID(),
      operationToken = randomUUID();
    const storageLocationId = await this.files.currentLocationId();
    const expiresAt = new Date(Date.now() + policy.ttlSeconds * 1000);
    const upload = await this.db.$transaction(
      async (tx) => {
        // Lock the user across groups, then the group across users, so quotas cannot race across tabs/instances.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM groups WHERE id = ${dto.groupId}::uuid FOR UPDATE`;
        await this.access.require(userId, dto.groupId, "canUpload", tx);
        if (dto.sessionId) {
          const session = await tx.classSession.findUnique({
            where: { id: dto.sessionId },
          });
          if (!session || session.groupId !== dto.groupId)
            fail(
              400,
              "SESSION_GROUP_MISMATCH",
              "Buổi học không thuộc nhóm này.",
            );
        }
        // Expired reservations keep their quota until storage cleanup succeeds.
        const active = { status: { in: IN_PROGRESS } };
        const [user, group] = await Promise.all([
          tx.uploadSession.aggregate({
            where: { ...active, userId },
            _count: true,
            _sum: { size: true },
          }),
          tx.uploadSession.aggregate({
            where: { ...active, groupId: dto.groupId },
            _count: true,
            _sum: { size: true },
          }),
        ]);
        if (
          user._count >= (policy.maxActivePerUser ?? 4) ||
          group._count >= (policy.maxActivePerGroup ?? 32) ||
          (user._sum.size ?? 0n) + BigInt(dto.size) >
            BigInt(policy.maxActiveBytesPerUser ?? 8 * 1024 ** 3) ||
          (group._sum.size ?? 0n) + BigInt(dto.size) >
            BigInt(policy.maxActiveBytesPerGroup ?? 64 * 1024 ** 3)
        ) {
          fail(
            429,
            "UPLOAD_QUOTA_EXCEEDED",
            "Đã đạt giới hạn tải lên đồng thời. Hãy đợi hoặc hủy file đang tải.",
          );
        }
        return tx.uploadSession.create({
          data: {
            id,
            groupId: dto.groupId,
            userId,
            filename: dto.filename.trim(),
            folderPath: dto.folderPath ?? "",
            size: BigInt(dto.size),
            mimeType: dto.mimeType,
            fingerprint: dto.fingerprint,
            source: dto.source,
            sessionId: dto.sessionId,
            objectKey: `groups/${dto.groupId}/uploads/${id}`,
            storageId: this.config.files?.driver === "local" ? id : "",
            driver: this.config.files?.driver ?? "s3",
            storageLocationId,
            partSize: policy.partSize,
            totalParts: Math.ceil(dto.size / policy.partSize),
            expiresAt,
            status: "INITIALIZING",
            operationToken,
            operationUntil: new Date(Date.now() + LEASE_MS),
          },
        });
      },
      { timeout: 10000, maxWait: 5000 },
    );
    let storageId = upload.storageId;
    const stopLease = this.renewLease(id, operationToken);
    try {
      storageId = await this.storage.create(
        upload.objectKey,
        upload.mimeType,
        dto.size,
        upload.partSize,
        expiresAt.getTime(),
        storageLocationId,
        id,
      );
      // Persist the S3 ID before checking authorization again so cleanup can find the upload.
      const saved = await this.db.uploadSession.updateMany({
        where: { id, operationToken },
        data: { storageId },
      });
      if (!saved.count) busy();
      await this.locked(userId, id, async (current, tx) => {
        if (
          current.status !== "INITIALIZING" ||
          current.operationToken !== operationToken
        )
          busy();
        await tx.uploadSession.update({
          where: { id },
          data: {
            status: "ACTIVE",
            operationToken: null,
            operationUntil: null,
          },
        });
      });
      return {
        uploadId: id,
        partSize: upload.partSize,
        totalParts: upload.totalParts,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      try {
        await this.storage.abort(
          upload.objectKey,
          storageId,
          storageLocationId,
        );
        await this.db.uploadSession.updateMany({
          where: { id, operationToken },
          data: {
            status: "ABORTED",
            operationToken: null,
            operationUntil: null,
          },
        });
      } catch {
        await this.db.uploadSession
          .updateMany({
            where: { id, operationToken },
            data: {
              storageId,
              operationUntil: new Date(0),
              expiresAt: new Date(0),
            },
          })
          .catch(() => {});
      }
      throw error;
    } finally {
      await stopLease();
    }
  }

  // These callbacks contain DB work only; no storage requests while row locks are held.
  private locked<T>(
    userId: string,
    id: string,
    work: (upload: UploadSession, tx: Prisma.TransactionClient) => Promise<T>,
    requireGroup = true,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const target = await tx.uploadSession.findUnique({ where: { id } });
        if (!target)
          fail(404, "UPLOAD_NOT_FOUND", "Không tìm thấy phiên tải lên.");
        await tx.$queryRaw`SELECT id FROM groups WHERE id = ${target.groupId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM upload_sessions WHERE id = ${id}::uuid FOR UPDATE`;
        const upload = (await tx.uploadSession.findUnique({ where: { id } }))!;
        const actor = await tx.user.findUnique({ where: { id: userId } });
        if (
          !actor ||
          actor.disabledAt ||
          (upload.userId !== userId && actor.globalRole !== "ADMIN")
        )
          fail(403, "FORBIDDEN", "Bạn không sở hữu phiên tải lên này.");
        if (requireGroup)
          await this.access.require(userId, upload.groupId, "canUpload", tx);
        return work(upload, tx);
      },
      { timeout: 10000, maxWait: 5000 },
    );
  }
  private active(upload: UploadSession) {
    if (upload.status !== "ACTIVE")
      fail(
        409,
        "UPLOAD_NOT_ACTIVE",
        "Phiên tải lên đang xử lý hoặc đã kết thúc.",
      );
    if (upload.expiresAt.getTime() <= Date.now())
      fail(
        410,
        "UPLOAD_EXPIRED",
        "Phiên tải lên đã hết hạn. Hãy hủy và tải lại.",
      );
  }
  async status(userId: string, id: string) {
    const check = (upload: UploadSession) => {
      if (
        !["COMPLETED", "ABORTED"].includes(upload.status) &&
        upload.expiresAt.getTime() <= Date.now()
      )
        fail(
          410,
          "UPLOAD_EXPIRED",
          "Phiên tải lên đã hết hạn. Hãy hủy và chọn file để tải lại.",
        );
      return upload;
    };
    const upload = await this.locked(userId, id, async (current) =>
      check(current),
    );
    // Storage I/O stays outside row locks. Terminal sessions never call ListParts.
    let uploadedParts: Awaited<ReturnType<MultipartStorageService["list"]>> =
      [];
    let objectReady = false;
    if (upload.status === "ACTIVE") {
      try {
        uploadedParts = await this.storage.list(
          upload.objectKey,
          upload.storageId,
          upload.storageLocationId,
        );
      } catch (error) {
        const latest = await this.locked(userId, id, async (current) =>
          check(current),
        );
        if (latest.status === "ACTIVE") {
          // Recover a storage completion whose DB commit/response was lost.
          const missing =
            (error as { name?: string }).name === "NoSuchUpload" ||
            (error as { code?: string }).code === "ENOENT";
          if (
            missing &&
            (await this.storage.size(
              upload.objectKey,
              upload.storageLocationId,
            )) === Number(upload.size)
          )
            objectReady = true;
          else
            fail(
              503,
              "STORAGE_UNAVAILABLE",
              "Chưa thể đối chiếu các phần tải lên. Hãy thử lại sau.",
            );
        }
      }
    }
    const current = await this.locked(userId, id, async (current) =>
      check(current),
    );
    return {
      uploadId: id,
      status: current.status,
      filename: current.filename,
      groupId: current.groupId,
      size: Number(current.size),
      fingerprint: current.fingerprint,
      partSize: current.partSize,
      totalParts: current.totalParts,
      expiresAt: current.expiresAt.toISOString(),
      objectReady,
      uploadedParts: current.status === "ACTIVE" ? uploadedParts : [],
      ...(current.fileId ? { fileId: current.fileId } : {}),
    };
  }

  async sign(userId: string, id: string, numbers: number[]) {
    const upload = await this.locked(userId, id, async (upload) => {
      this.active(upload);
      return upload;
    });
    if (numbers.some((n) => n > upload.totalParts))
      fail(400, "INVALID_PART_NUMBER", "Số thứ tự phần không hợp lệ.");
    const seconds = Math.max(
      1,
      Math.min(
        60,
        Math.floor((upload.expiresAt.getTime() - Date.now()) / 1000),
      ),
    );
    const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    const parts = await Promise.all(
      numbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.sign(
          upload.objectKey,
          upload.storageId,
          partNumber,
          seconds,
          upload.storageLocationId,
        ),
        expiresAt,
      })),
    );
    await this.locked(userId, id, async (current) => {
      this.active(current);
    });
    return { parts };
  }

  async complete(userId: string, id: string, dto: CompleteUploadDto) {
    const token = randomUUID(),
      deadline = Date.now() + 8000;
    let upload: UploadSession;
    for (;;) {
      const claim = await this.locked(userId, id, async (current, tx) => {
        if (current.status === "COMPLETED") return current;
        if (
          current.status === "COMPLETING" &&
          (current.operationUntil?.getTime() ?? 0) > Date.now()
        )
          return null;
        if (current.status !== "COMPLETING") this.active(current);
        if (current.expiresAt.getTime() <= Date.now())
          fail(410, "UPLOAD_EXPIRED", "Phiên tải lên đã hết hạn.");
        return tx.uploadSession.update({
          where: { id },
          data: {
            status: "COMPLETING",
            operationToken: token,
            operationUntil: new Date(Date.now() + LEASE_MS),
          },
        });
      });
      if (claim) {
        upload = claim;
        break;
      }
      if (Date.now() >= deadline) busy();
      await delay(100); // Duplicate completions wait without holding DB connections/locks.
    }
    if (upload.status !== "COMPLETED") {
      const stopLease = this.renewLease(id, token);
      try {
        let size = await this.storage.size(
          upload.objectKey,
          upload.storageLocationId,
        );
        if (size === null) {
          const actual = await this.storage.list(
            upload.objectKey,
            upload.storageId,
            upload.storageLocationId,
          );
          const requested = [...dto.parts].sort(
            (a, b) => a.partNumber - b.partNumber,
          );
          if (
            actual.length !== upload.totalParts ||
            requested.length !== actual.length ||
            actual.some(
              (part, index) =>
                part.partNumber !== index + 1 ||
                requested[index].partNumber !== part.partNumber ||
                requested[index].etag !== part.etag,
            )
          )
            fail(
              409,
              "MISSING_PARTS",
              "Thiếu phần tải lên hoặc ETag không khớp.",
            );
          if (
            actual.some(
              (part, index) =>
                part.size !==
                Math.min(
                  upload.partSize,
                  Number(upload.size) - index * upload.partSize,
                ),
            )
          )
            fail(409, "SIZE_MISMATCH", "Kích thước phần tải lên không khớp.");
          await this.storage.complete(
            upload.objectKey,
            upload.storageId,
            actual,
            upload.storageLocationId,
          );
          size = await this.storage.size(
            upload.objectKey,
            upload.storageLocationId,
          );
        }
        if (size !== Number(upload.size))
          fail(409, "SIZE_MISMATCH", "Kích thước file không khớp.");
        upload = await this.locked(userId, id, async (current, tx) => {
          if (
            current.status !== "COMPLETING" ||
            current.operationToken !== token
          )
            busy();
          const file = await tx.libraryFile.create({
            data: {
              groupId: current.groupId,
              createdBy: current.userId,
              name: current.filename,
              folderPath: current.folderPath,
              size: current.size,
              mimeType: current.mimeType,
              source: current.source,
              sessionId: current.sessionId,
              objectKey: current.objectKey,
              storageLocationId: current.storageLocationId,
              status: "AVAILABLE",
            },
          });
          return tx.uploadSession.update({
            where: { id },
            data: {
              status: "COMPLETED",
              fileId: file.id,
              operationToken: null,
              operationUntil: null,
            },
          });
        });
      } catch (error) {
        // HeadObject/local size recovers an object completed before a failed DB commit.
        await this.db.uploadSession
          .updateMany({
            where: { id, status: "COMPLETING", operationToken: token },
            data: {
              status: "ACTIVE",
              operationToken: null,
              operationUntil: null,
            },
          })
          .catch(() => {});
        throw error;
      } finally {
        await stopLease();
      }
    }
    await this.storage
      .releaseLocal(upload.storageId, upload.storageLocationId)
      .catch(() => {});
    const file = (await this.db.libraryFile.findUnique({
      where: { id: upload.fileId! },
    }))!;
    return { uploadId: id, status: "COMPLETED", file: presentFile(file) };
  }

  async abort(userId: string, id: string) {
    const token = randomUUID();
    const upload = await this.locked(
      userId,
      id,
      async (current, tx) => {
        if (current.status === "COMPLETED")
          fail(
            409,
            "ALREADY_COMPLETED",
            "File đã hoàn tất, hãy xóa từ thư viện.",
          );
        if (current.status === "ABORTED") return null;
        if (
          current.operationUntil &&
          current.operationUntil.getTime() > Date.now()
        )
          busy();
        return tx.uploadSession.update({
          where: { id },
          data: {
            status: "ABORTING",
            operationToken: token,
            operationUntil: new Date(Date.now() + LEASE_MS),
          },
        });
      },
      false,
    );
    if (upload) await this.finishAbort(upload, token);
  }
  private async finishAbort(upload: UploadSession, token: string) {
    const stopLease = this.renewLease(upload.id, token);
    try {
      await this.storage.abort(
        upload.objectKey,
        upload.storageId,
        upload.storageLocationId,
      );
      await this.storage.deleteObject(
        upload.objectKey,
        upload.storageLocationId,
      );
      await this.db.uploadSession.updateMany({
        where: { id: upload.id, status: "ABORTING", operationToken: token },
        data: { status: "ABORTED", operationToken: null, operationUntil: null },
      });
    } catch (error) {
      await this.db.uploadSession
        .updateMany({
          where: { id: upload.id, operationToken: token },
          data: { operationUntil: new Date(Date.now() + 30000) },
        })
        .catch(() => {});
      throw error;
    } finally {
      await stopLease();
    }
  }
  private renewLease(id: string, operationToken: string) {
    let pending: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (pending) return;
      pending = this.db.uploadSession
        .updateMany({
          where: { id, operationToken, status: { in: IN_PROGRESS } },
          data: { operationUntil: new Date(Date.now() + LEASE_MS) },
        })
        .catch((error) => {
          console.warn(
            JSON.stringify({
              event: "upload_lease_renewal_failed",
              uploadId: id,
              code: safeErrorCode(error),
            }),
          );
        })
        .finally(() => {
          pending = undefined;
        });
    }, 60000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await pending;
    };
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.cleanupExpired();
    }, 30000);
    this.timer.unref();
  }
  cleanupExpired(options: { cutoffAt?: Date; limit?: number } = {}) {
    if (
      (options.cutoffAt && !Number.isFinite(options.cutoffAt.getTime())) ||
      (options.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1))
    )
      throw new RangeError("Invalid cleanup cutoffAt/limit");
    if (this.cleanup) return this.cleanup;
    const cutoff = new Date(
      Math.min(options.cutoffAt?.getTime() ?? Date.now(), Date.now()),
    );
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    this.cleanup = this.processExpired(cutoff, limit)
      .catch((error) => {
        console.warn(
          JSON.stringify({
            event: "upload_cleanup_unavailable",
            code: safeErrorCode(error),
          }),
        );
        return { scanned: 0, aborted: 0, failed: 1 };
      })
      .finally(() => {
        this.cleanup = undefined;
      });
    return this.cleanup;
  }
  private async processExpired(cutoff: Date, limit: number) {
    const result = { scanned: 0, aborted: 0, failed: 0 };
    for (let n = 0; n < limit; n++) {
      const token = randomUUID();
      const rows = await this.db.$queryRaw<Array<{ id: string }>>`
        UPDATE upload_sessions SET status = 'ABORTING', operation_token = ${token}::uuid, operation_until = now() + interval '5 minutes'
        WHERE id = (SELECT id FROM upload_sessions
          WHERE status IN ('INITIALIZING', 'ACTIVE', 'COMPLETING', 'ABORTING')
          AND (expires_at <= ${cutoff} OR status = 'ABORTING')
          AND (operation_until IS NULL OR operation_until <= now())
          ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id`;
      if (!rows[0]) break;
      result.scanned++;
      const upload = await this.db.uploadSession.findUnique({
        where: { id: rows[0].id },
      });
      if (upload) {
        try {
          await this.finishAbort(upload, token);
          result.aborted++;
        } catch (error) {
          result.failed++;
          console.warn(
            JSON.stringify({
              event: "uploads.cleanup.v1",
              uploadId: upload.id,
              code: safeErrorCode(error),
            }),
          );
        }
      }
    }
    return result;
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.cleanup;
  }
}
