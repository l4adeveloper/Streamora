import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safeErrorCode } from "../../common/safe-error-code";
import type { FileStorageService } from "./file-storage.service";

type TrashObject = {
  trashBucket: string;
  trashKey: string;
  objectKey: string;
  storageLocationId: string | null;
  size: bigint;
};

type ArchiveStep = "READ_S3" | "COPY_TO_GCS" | "VERIFY_GCS";
type ReportProgress = (bytes: number, total: number) => void;

class TrashArchiveError extends Error {
  constructor(
    readonly step: ArchiveStep,
    cause: unknown,
  ) {
    super("Trash archive failed", { cause });
  }
}

const storageErrorCodes = new Set([
  "TRASH_SOURCE_CHANGED",
  "TRASH_COPY_MISMATCH",
  "TRASH_MULTIPART_MISSING",
  "TRASH_STATE_INVALID",
  "CONTENT_UPLOAD_MISMATCH",
  "CONTENT_DOWNLOAD_MISMATCH",
  "AccessDenied",
  "AuthorizationHeaderMalformed",
  "PermanentRedirect",
  "NoSuchKey",
  "NoSuchBucket",
  "NotFound",
  "ExpiredToken",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "CredentialsProviderError",
  "AbortError",
  "invalid_grant",
  "invalid_target",
  "unauthorized_client",
  "invalid_request",
  "invalid_scope",
  "permissionDenied",
  "forbidden",
  "insufficientPermissions",
]);

export function trashFailureDetails(error: unknown) {
  const step = error instanceof TrashArchiveError ? error.step : undefined;
  const failure = error instanceof TrashArchiveError ? error.cause : error;
  const details = failure as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    $response?: { headers?: Record<string, unknown> };
    response?: { status?: unknown; data?: { error?: unknown } };
    cause?: {
      code?: unknown;
      response?: { status?: unknown; data?: { error?: unknown } };
    };
  } | null;
  const httpStatus = [
    details?.$metadata?.httpStatusCode,
    details?.response?.status,
    details?.cause?.response?.status,
    details?.code,
  ].find(
    (status) =>
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599,
  );
  const knownCode = [
    details?.name,
    details?.message,
    details?.code,
    details?.cause?.code,
    details?.response?.data?.error,
    details?.cause?.response?.data?.error,
  ].find((code) => typeof code === "string" && storageErrorCodes.has(code));
  const safeCode = safeErrorCode(failure);
  const bucketRegion = details?.$response?.headers?.["x-amz-bucket-region"];
  return {
    ...(step ? { step } : {}),
    code:
      knownCode ??
      (safeCode === "UNKNOWN" && httpStatus ? `HTTP_${httpStatus}` : safeCode),
    ...(httpStatus ? { httpStatus } : {}),
    ...(typeof bucketRegion === "string" &&
    /^[a-z]{2}(-[a-z]+)+-\d+$/.test(bucketRegion)
      ? { bucketRegion }
      : {}),
  };
}

export class FileTrashStorage {
  private readonly gcs: Storage;

  constructor(
    private readonly files: FileStorageService,
    projectId?: string,
  ) {
    this.gcs = new Storage({ projectId, timeout: 30_000 });
  }

  async archive(
    object: TrashObject,
    signal: AbortSignal,
    report?: ReportProgress,
  ) {
    let step: ArchiveStep = "READ_S3";
    try {
      const { client, bucket } = await this.files.s3(object.storageLocationId);
      const source = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: object.objectKey,
        }),
        { abortSignal: signal },
      );
      const body = source.Body as Readable | undefined;
      if (
        !body ||
        source.ContentLength !== Number(object.size) ||
        !source.ETag
      ) {
        body?.destroy();
        throw new Error("TRASH_SOURCE_CHANGED");
      }
      step = "COPY_TO_GCS";
      const file = this.gcs.bucket(object.trashBucket).file(object.trashKey);
      let bytes = 0;
      const hash = createHash("md5");
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const upload = file.createWriteStream({
        resumable: true,
        validation: "crc32c",
        metadata: {
          contentType: source.ContentType ?? "application/octet-stream",
          contentEncoding: source.ContentEncoding,
          contentDisposition: source.ContentDisposition,
          contentLanguage: source.ContentLanguage,
          cacheControl: source.CacheControl,
        },
      });
      if (report)
        upload.on("progress", ({ bytesWritten }: { bytesWritten: number }) =>
          report(bytesWritten, Number(object.size)),
        );
      await pipeline(body, meter, upload, { signal });
      step = "VERIFY_GCS";
      const [metadata] = await file.getMetadata();
      if (
        bytes !== source.ContentLength ||
        Number(metadata.size) !== bytes ||
        metadata.md5Hash !== hash.digest("base64") ||
        !metadata.generation
      )
        throw new Error("TRASH_COPY_MISMATCH");
      return { generation: String(metadata.generation), etag: source.ETag };
    } catch (error) {
      throw new TrashArchiveError(step, error);
    }
  }

  async removeOriginal(
    object: TrashObject,
    etag: string,
    generation: string,
    signal: AbortSignal,
  ) {
    const [archive] = await this.gcs
      .bucket(object.trashBucket)
      .file(object.trashKey, { generation })
      .getMetadata();
    if (Number(archive.size) !== Number(object.size) || !archive.md5Hash)
      throw new Error("TRASH_COPY_MISMATCH");
    const { client, bucket } = await this.files.s3(object.storageLocationId);
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: object.objectKey,
          IfMatch: etag,
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      const s3 = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      // A retry can follow an S3 delete that succeeded before the database checkpoint.
      if (s3.$metadata?.httpStatusCode !== 404 || s3.name === "NoSuchBucket")
        throw error;
    }
  }

  async restore(
    object: TrashObject,
    generation: string,
    signal: AbortSignal,
    report?: ReportProgress,
  ) {
    const file = this.gcs
      .bucket(object.trashBucket)
      .file(object.trashKey, { generation });
    const [metadata] = await file.getMetadata();
    const size = Number(object.size);
    if (Number(metadata.size) !== size || !metadata.crc32c)
      throw new Error("TRASH_COPY_MISMATCH");

    const { client, bucket } = await this.files.s3(object.storageLocationId);
    const target = { Bucket: bucket, Key: object.objectKey };
    const headers = {
      ContentType: metadata.contentType,
      ContentEncoding: metadata.contentEncoding,
      ContentDisposition: metadata.contentDisposition,
      ContentLanguage: metadata.contentLanguage,
      CacheControl: metadata.cacheControl,
    };
    const partSize = Math.max(16 * 1024 ** 2, Math.ceil(size / 10_000));
    const send = { abortSignal: signal };
    let uploadId: string | undefined;
    let downloaded = 0;
    let uploaded = 0;
    const parts: CompletedPart[] = [];
    const stream = file.createReadStream({
      decompress: false,
      validation: "crc32c",
    });
    // pipeline propagates GCS checksum, stream and cancellation errors to the uploader.
    try {
      if (size > partSize) {
        ({ UploadId: uploadId } = await client.send(
          new CreateMultipartUploadCommand({
            ...target,
            ...headers,
            ChecksumAlgorithm: "CRC32",
          }),
          send,
        ));
        if (!uploadId) throw new Error("TRASH_MULTIPART_MISSING");
      }
      const uploadPart = async (body: Buffer) => {
        const PartNumber = parts.length + 1;
        const result = await client.send(
          new UploadPartCommand({
            ...target,
            UploadId: uploadId,
            PartNumber,
            Body: body,
            ContentLength: body.length,
            ChecksumAlgorithm: "CRC32",
          }),
          send,
        );
        if (!result.ETag) throw new Error("TRASH_MULTIPART_MISSING");
        uploaded += body.length;
        report?.(downloaded + uploaded, size * 2);
        parts.push({
          PartNumber,
          ETag: result.ETag,
          ChecksumCRC32: result.ChecksumCRC32,
        });
      };
      await pipeline(
        stream,
        async (source: AsyncIterable<Buffer>) => {
          const buffer = Buffer.allocUnsafe(Math.min(size, partSize));
          let used = 0;
          for await (const chunk of source) {
            downloaded += chunk.length;
            if (downloaded > size) throw new Error("TRASH_COPY_MISMATCH");
            report?.(downloaded + uploaded, size * 2);
            let offset = 0;
            while (offset < chunk.length) {
              const copied = chunk.copy(buffer, used, offset);
              offset += copied;
              used += copied;
              if (uploadId && used === buffer.length) {
                await uploadPart(buffer);
                used = 0;
              }
            }
          }
          if (downloaded !== size) throw new Error("TRASH_COPY_MISMATCH");
          if (uploadId) {
            if (used) await uploadPart(buffer.subarray(0, used));
            await client.send(
              new CompleteMultipartUploadCommand({
                ...target,
                UploadId: uploadId,
                MultipartUpload: { Parts: parts },
              }),
              send,
            );
            uploadId = undefined;
          } else {
            await client.send(
              new PutObjectCommand({
                ...target,
                ...headers,
                Body: buffer,
                ContentLength: downloaded,
              }),
              send,
            );
            report?.(size * 2, size * 2);
          }
        },
        { signal },
      );
    } finally {
      stream.destroy();
      if (uploadId)
        await client
          .send(
            new AbortMultipartUploadCommand({
              ...target,
              UploadId: uploadId,
            }),
          )
          .catch(() => {});
    }
  }

  async removeArchive(object: TrashObject, generation: string) {
    await this.gcs
      .bucket(object.trashBucket)
      .file(object.trashKey, { generation })
      .delete({ ignoreNotFound: true });
  }
}
