import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { ApiError } from "../../common/api-error";
import { LocalFileStorage, attachmentName } from "./local-file-storage";

@Injectable()
export class FileStorageService implements OnModuleDestroy {
  private readonly client?: S3Client;
  private readonly local?: LocalFileStorage;
  constructor(@Inject(APP_CONFIG) private readonly config: EnvironmentConfig) {
    if (config.files?.driver === "local") {
      this.local = new LocalFileStorage({
        directory: config.files.localDirectory!,
        secret: config.auth.accessTokenSecret,
        ttlSeconds: config.files.downloadTtlSeconds,
        baseUrl: config.files.publicBaseUrl!,
      });
      return;
    }
    this.client = new S3Client({
      region: config.files?.region ?? "ap-southeast-1",
      requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
      maxAttempts: 2,
    });
  }
  private bucket() {
    if (!this.config.files?.bucket)
      throw new ApiError(
        503,
        "STORAGE_UNAVAILABLE",
        "Lưu trữ tài liệu chưa được cấu hình.",
      );
    return this.config.files.bucket;
  }
  async download(objectKey: string, name: string, preview = false) {
    if (this.local)
      return this.local.download(objectKey, name, undefined, preview);
    const Bucket = this.bucket();
    const seconds = this.config.files?.downloadTtlSeconds ?? 120;
    const now = new Date();
    try {
      const url = await getSignedUrl(
        this.client!,
        new GetObjectCommand({
          Bucket,
          Key: objectKey,
          ResponseContentDisposition: attachmentName(name, preview),
          ...(preview
            ? {
                ResponseContentType: "application/pdf",
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
  async delete(objectKey: string) {
    if (this.local) return this.local.delete(objectKey);
    await this.client!.send(
      new DeleteObjectCommand({ Bucket: this.bucket(), Key: objectKey }),
    );
  }
  onModuleDestroy() {
    this.client?.destroy();
  }
  async openLocalDownload(token: string) {
    if (!this.local)
      throw new ApiError(404, "NOT_FOUND", "Không tìm thấy đường dẫn tải.");
    return this.local.openDownload(token);
  }
  async importLocalFile(sourcePath: string, objectKey: string) {
    if (!this.local)
      throw new ApiError(
        409,
        "LOCAL_STORAGE_REQUIRED",
        "Chức năng nhập file chỉ dùng cho chế độ local.",
      );
    return this.local.importFile(sourcePath, objectKey);
  }
}
