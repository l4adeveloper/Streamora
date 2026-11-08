import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { resolve } from "node:path";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { ApiError } from "../../common/api-error";
import { FileStorageService } from "../files/file-storage.service";
import {
  configuredStorage,
  locationId,
  type StorageTarget,
} from "../files/storage-locations.service";
import {
  LocalMultipartStorage,
  type StoredPart,
} from "./local-multipart-storage";

type Backend = {
  target: StorageTarget;
  s3?: S3Client;
  local?: LocalMultipartStorage;
};
@Injectable()
export class MultipartStorageService implements OnModuleDestroy {
  private readonly currentId: string;
  private readonly backends = new Map<string, Backend>();
  private readonly s3?: S3Client;
  private readonly local?: LocalMultipartStorage;
  constructor(
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
    private readonly files: FileStorageService,
  ) {
    const target = configuredStorage(config);
    this.currentId = locationId(target);
    const current = this.createBackend(this.currentId, target);
    this.s3 = current.s3;
    this.local = current.local;
  }
  private createBackend(id: string, target: StorageTarget) {
    const backend: Backend = { target };
    if (target.driver === "local")
      backend.local = new LocalMultipartStorage({
        directory: resolve(target.directory, "../uploads"),
        secret: this.config.auth.accessTokenSecret,
        origin: this.config.webOrigin,
        port:
          id === this.currentId ? (this.config.uploads?.localPort ?? 4002) : 0,
      });
    else
      backend.s3 = new S3Client({
        requestChecksumCalculation: "WHEN_REQUIRED",
        region: target.region,
        maxAttempts: 2,
        requestHandler: { connectionTimeout: 3000, requestTimeout: 30000 },
      });
    this.backends.set(id, backend);
    return backend;
  }
  private async backend(id?: string | null) {
    if (!id || id === this.currentId)
      return {
        target: configuredStorage(this.config),
        s3: this.s3,
        local: this.local,
      };
    const target = await this.files.locations.resolve(id);
    return this.backends.get(id) ?? this.createBackend(id, target);
  }
  private object(target: StorageTarget, key: string) {
    if (target.driver !== "s3" || !target.bucket)
      throw new ApiError(503, "STORAGE_UNAVAILABLE", "Chưa cấu hình S3.");
    return { Bucket: target.bucket, Key: key };
  }
  async create(
    key: string,
    type: string,
    size: number,
    partSize: number,
    expires: number,
    location?: string | null,
    localId?: string,
  ) {
    const backend = await this.backend(location);
    if (backend.local)
      return backend.local.create(key, size, partSize, expires, localId);
    return (
      await backend.s3!.send(
        new CreateMultipartUploadCommand({
          ...this.object(backend.target, key),
          ContentType: type,
        }),
      )
    ).UploadId!;
  }
  async sign(
    key: string,
    id: string,
    partNumber: number,
    seconds: number,
    location?: string | null,
  ) {
    const backend = await this.backend(location);
    if (backend.local)
      return backend.local.sign(id, partNumber, Math.min(60, seconds));
    return getSignedUrl(
      backend.s3!,
      new UploadPartCommand({
        ...this.object(backend.target, key),
        UploadId: id,
        PartNumber: partNumber,
      }),
      { expiresIn: Math.min(60, seconds) },
    );
  }
  async list(
    key: string,
    id: string,
    location?: string | null,
  ): Promise<StoredPart[]> {
    const backend = await this.backend(location);
    if (backend.local) return backend.local.list(id);
    const result: StoredPart[] = [];
    let marker: string | undefined;
    do {
      const page = await backend.s3!.send(
        new ListPartsCommand({
          ...this.object(backend.target, key),
          UploadId: id,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? [])
        result.push({
          partNumber: part.PartNumber!,
          etag: part.ETag!,
          size: part.Size!,
        });
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return result;
  }
  async size(key: string, location?: string | null) {
    const backend = await this.backend(location);
    if (backend.local) return this.files.localSize(key, location);
    try {
      return (
        (
          await backend.s3!.send(
            new HeadObjectCommand(this.object(backend.target, key)),
          )
        ).ContentLength ?? null
      );
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode: number } }).$metadata
          ?.httpStatusCode === 404
      )
        return null;
      throw error;
    }
  }
  async complete(
    key: string,
    id: string,
    parts: StoredPart[],
    location?: string | null,
  ) {
    const backend = await this.backend(location);
    if (backend.local)
      return backend.local.complete(id, parts, (path) =>
        this.files.importLocalFile(path, key, location),
      );
    await backend.s3!.send(
      new CompleteMultipartUploadCommand({
        ...this.object(backend.target, key),
        UploadId: id,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }
  async abort(key: string, id: string, location?: string | null) {
    if (!id) return;
    const backend = await this.backend(location);
    if (backend.local) return backend.local.abort(id);
    try {
      await backend.s3!.send(
        new AbortMultipartUploadCommand({
          ...this.object(backend.target, key),
          UploadId: id,
        }),
      );
    } catch (error) {
      if ((error as { name: string }).name !== "NoSuchUpload") throw error;
    }
  }
  async releaseLocal(id: string, location?: string | null) {
    await (await this.backend(location)).local?.abort(id);
  }
  async deleteObject(key: string, location?: string | null) {
    await this.files.delete(key, location);
  }
  async onModuleDestroy() {
    for (const backend of this.backends.values()) {
      await backend.local?.close();
      backend.s3?.destroy();
    }
  }
}
