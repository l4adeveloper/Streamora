import { Injectable } from "@nestjs/common";
import type {
  VideoPlaybackResponse,
  VideoPlaybackSource,
} from "@streamora/contracts";
import type { LibraryFile, Prisma } from "../../generated/prisma/client";
import { ApiError } from "../../common/api-error";
import { FileStorageService } from "./file-storage.service";
import { VideoRenditionCatalog } from "./video-rendition-catalog";
import type { DeliveryCookie } from "../video-processing/video-delivery";

export const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
@Injectable()
export class VideoPlaybackService {
  constructor(
    private readonly storage: FileStorageService,
    private readonly catalog: VideoRenditionCatalog,
  ) {}
  async manifest(
    file: LibraryFile,
    tx: Prisma.TransactionClient,
  ): Promise<VideoPlaybackResponse & { deliveryCookies?: DeliveryCookie[] }> {
    const snapshot = await this.catalog.read(file, tx);
    if (
      !VIDEO_TYPES.has(file.mimeType) &&
      !["application/vnd.apple.mpegurl", "application/x-mpegURL"].includes(
        file.mimeType,
      ) &&
      !snapshot.hls
    )
      throw new ApiError(
        415,
        "VIDEO_PREVIEW_UNSUPPORTED",
        "Chỉ hỗ trợ xem trước video MP4, WebM và MOV tương thích trình duyệt.",
      );
    const source =
      snapshot.hasOriginal === false
        ? undefined
        : await this.storage.download(
            file.objectKey,
            file.name,
            true,
            file.mimeType,
            file.storageLocationId,
          );
    const sources: VideoPlaybackSource[] = source
      ? [
          {
            id: "original",
            label: "Bản gốc",
            kind: "file",
            mimeType: file.mimeType,
            height: null,
            bitrate: null,
            ...source,
          },
        ]
      : [];
    const ids = new Set(["original", "adaptive"]);
    for (const rendition of snapshot.renditions.slice(0, 8)) {
      if (
        ids.has(rendition.id) ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(rendition.id) ||
        !Number.isInteger(rendition.height) ||
        rendition.height <= 0 ||
        !Number.isFinite(rendition.bitrate) ||
        rendition.bitrate <= 0 ||
        !VIDEO_TYPES.has(rendition.mimeType) ||
        !/^[A-Za-z0-9_./-]+$/.test(rendition.objectKey) ||
        !rendition.objectKey.startsWith(
          `groups/${file.groupId}/videos/${file.id}/`,
        ) ||
        rendition.objectKey
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      ) {
        throw new ApiError(
          503,
          "VIDEO_OUTPUT_INVALID",
          "Các phiên bản video chưa sẵn sàng. Hãy thử lại sau.",
        );
      }
      ids.add(rendition.id);
      sources.push({
        id: rendition.id,
        label: `${rendition.height}p`,
        kind: "file",
        mimeType: rendition.mimeType,
        height: rendition.height,
        bitrate: rendition.bitrate,
        ...(await this.storage.download(
          rendition.objectKey,
          file.name,
          true,
          rendition.mimeType,
          rendition.storageLocationId ?? file.storageLocationId,
        )),
      });
    }
    if (snapshot.hls) {
      const url = new URL(snapshot.hls.url, "http://localhost");
      if (
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
          )) ||
        Date.parse(snapshot.hls.expiresAt) <= Date.now() ||
        Date.parse(snapshot.hls.expiresAt) > Date.now() + 60000 ||
        !Number.isFinite(Date.parse(snapshot.hls.expiresAt))
      )
        throw new ApiError(
          503,
          "VIDEO_OUTPUT_INVALID",
          "Liên kết video chưa sẵn sàng.",
        );
      sources.push({
        id: "adaptive",
        label: "Tự động",
        kind: "hls",
        mimeType: "application/vnd.apple.mpegurl",
        height: null,
        bitrate: null,
        ...snapshot.hls,
      });
    }
    return {
      fileId: file.id,
      processing: {
        status: snapshot.status,
        progressPercent: snapshot.progressPercent,
      },
      sources,
      ...(snapshot.qualities ? { qualities: snapshot.qualities } : {}),
      ...(snapshot.thumbnail ? { thumbnail: snapshot.thumbnail } : {}),
      ...(snapshot.deliveryCookies
        ? { deliveryCookies: snapshot.deliveryCookies }
        : {}),
    };
  }
}
