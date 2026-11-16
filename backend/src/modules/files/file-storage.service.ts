import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Inject, Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { ApiError } from "../../common/api-error";
import { LocalFileStorage, attachmentName } from "./local-file-storage";
import {
  StorageLocationsService,
  type StorageTarget,
} from "./storage-locations.service";

type Backend = {
  target: StorageTarget;
  local?: LocalFileStorage;
  client?: S3Client;
};
@Injectable()
export class FileStorageService implements OnModuleDestroy {
  private client?: S3Client;
  private local?: LocalFileStorage;
  readonly locations: StorageLocationsService;
  private readonly backends = new Map<string, Backend>();
  constructor(
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
    @Optional() locations?: StorageLocationsService,
  ) {
    this.locations = locations ?? new StorageLocationsService(config);
    const current = this.createBackend(
      this.locations.id,
      this.locations.target,
    );
    this.local = current.local;
    this.client = current.client;
  }
  private createBackend(id: string, target: StorageTarget): Backend {
    const backend: Backend = { target };
    if (target.driver === "local")
      backend.local = new LocalFileStorage({
        directory: target.directory,
        secret: this.config.auth.accessTokenSecret,
        ttlSeconds: Math.min(60, this.config.files?.downloadTtlSeconds ?? 60),
        baseUrl:
          this.config.files?.publicBaseUrl ??
          `http://127.0.0.1:${this.config.port ?? 4000}`,
        locationId: id,
      });
    else
      backend.client = new S3Client({
        region: target.region,
        requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
        maxAttempts: 2,
      });
    this.backends.set(id, backend);
    return backend;
  }
  currentLocationId(): Promise<string | null> {
    if (this.locations.target.driver === "s3" && !this.locations.target.bucket)
      return Promise.resolve(null);
    return this.locations.current();
  }
  private async backend(id?: string | null): Promise<Backend> {
    if (!id || id === this.locations.id)
      return {
        target: this.locations.target,
        local: this.local,
        client: this.client,
      };
    const target = await this.locations.resolve(id);
    return this.backends.get(id) ?? this.createBackend(id, target);
  }
  private bucket(target: StorageTarget) {
    if (target.driver !== "s3" || !target.bucket)
      throw new ApiError(
        503,
        "STORAGE_UNAVAILABLE",
        "Lưu trữ tài liệu chưa được cấu hình.",
      );
    return target.bucket;
  }
  async download(
    objectKey: string,
    name: string,
    preview = false,
    mimeType = "application/pdf",
    locationId?: string | null,
  ) {
    const backend = await this.backend(locationId);
    if (backend.local)
      return backend.local.download(
        objectKey,
        name,
        undefined,
        preview,
        mimeType,
      );
    const seconds = Math.min(60, this.config.files?.downloadTtlSeconds ?? 60),
      now = new Date();
    const Bucket = this.bucket(backend.target);
    try {
      const url = await getSignedUrl(
        backend.client!,
        new GetObjectCommand({
          Bucket,
          Key: objectKey,
          ResponseContentDisposition: attachmentName(name, preview),
          ...(preview
            ? {
                ResponseContentType: mimeType,
                ResponseCacheControl: "no-store",
              }
            : {}),
        }),
        { expiresIn: seconds, signingDate: now },
      );
      return {
        url,
        expiresAt: new Date(now.getTime() + seconds * 1000).toISOString(),
      };
    } catch {
      throw new ApiError(
        503,
        "STORAGE_UNAVAILABLE",
        "Chưa thể cấp liên kết tải. Vui lòng thử lại.",
      );
    }
  }
  async read(
    objectKey: string,
    locationId?: string | null,
    signal?: AbortSignal,
  ): Promise<Readable> {
    signal?.throwIfAborted();
    const backend = await this.backend(locationId);
    if (backend.local) {
      const grant = await backend.local.download(objectKey, "download");
      return (
        await backend.local.openDownload(
          new URL(grant.url).searchParams.get("token") ?? "",
        )
      ).stream;
    }
    const result = await backend.client!.send(
      new GetObjectCommand({
        Bucket: this.bucket(backend.target),
        Key: objectKey,
      }),
      { abortSignal: signal },
    );
    return result.Body as Readable;
  }
  async delete(objectKey: string, locationId?: string | null) {
    const backend = await this.backend(locationId);
    if (backend.local) return backend.local.delete(objectKey);
    await backend.client!.send(
      new DeleteObjectCommand({
        Bucket: this.bucket(backend.target),
        Key: objectKey,
      }),
    );
  }
  async writeText(objectKey: string, text: string, locationId?: string | null) {
    const backend = await this.backend(locationId);
    if (backend.local) return backend.local.writeText(objectKey, text);
    await backend.client!.send(new PutObjectCommand({
      Bucket: this.bucket(backend.target), Key: objectKey,
      Body: Buffer.from(text, "utf8"), ContentType: "text/markdown; charset=utf-8",
    }));
  }
  async openLocalDownload(token: string, range?: string, head = false) {
    let id: string | undefined;
    try {
      if (typeof token !== "string" || token.length > 8192) throw new Error();
      id = JSON.parse(
        Buffer.from(token.split(".")[0], "base64url").toString(),
      ).locationId;
      if (id !== undefined && !/^[a-f0-9]{64}$/.test(id)) throw new Error();
    } catch {
      throw new ApiError(
        403,
        "DOWNLOAD_LINK_INVALID",
        "Liên kết tải không hợp lệ hoặc đã hết hạn.",
      );
    }
    // The location is opaque; its directory comes only from the server registry.
    // The selected backend verifies the HMAC before accessing any file bytes.
    const backend = await this.backend(id);
    if (!backend.local)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "Không tìm thấy đường dẫn tải local.",
      );
    return backend.local.openDownload(token, undefined, range, head);
  }
  async importLocalFile(
    sourcePath: string,
    objectKey: string,
    locationId?: string | null,
  ) {
    const backend = await this.backend(locationId);
    if (!backend.local)
      throw new ApiError(
        409,
        "LOCAL_STORAGE_REQUIRED",
        "Chức năng nhập file chỉ dùng cho chế độ local.",
      );
    return backend.local.importFile(sourcePath, objectKey);
  }
  /** Stores worker output in the same storage as its source, including S3. */
  async writeFile(
    sourcePath: string,
    objectKey: string,
    mimeType: string,
    locationId?: string | null,
  ) {
    const backend = await this.backend(locationId);
    if (backend.local) return backend.local.importFile(sourcePath, objectKey);
    const info = await stat(sourcePath);
    const body = createReadStream(sourcePath);
    try {
      await backend.client!.send(
        new PutObjectCommand({
          Bucket: this.bucket(backend.target),
          Key: objectKey,
          Body: body,
          ContentLength: info.size,
          ContentType: mimeType,
        }),
      );
    } finally {
      body.destroy();
    }
  }
  async localSize(objectKey: string, locationId?: string | null) {
    return (await this.backend(locationId)).local!.size(objectKey);
  }
  onModuleDestroy() {
    for (const backend of this.backends.values()) backend.client?.destroy();
  }
}
