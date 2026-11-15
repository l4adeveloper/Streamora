import { Injectable } from "@nestjs/common";
import type { VideoProcessingStatus } from "@streamora/contracts";
import type { LibraryFile, Prisma } from "../../generated/prisma/client";

export interface VideoProcessingSnapshot {
  hasOriginal?: boolean;
  qualities?: import("@streamora/contracts").VideoQuality[];
  thumbnail?: string;
  deliveryCookies?: import("../video-processing/video-delivery").DeliveryCookie[];
  status: VideoProcessingStatus;
  progressPercent: number | null;
  // Only fully published objects are ready.
  renditions: {
    id: string;
    height: number;
    bitrate: number;
    mimeType: string;
    objectKey: string;
    storageLocationId?: string;
  }[];
  hls?: { url: string; expiresAt: string; public?: boolean };
}
export abstract class VideoRenditionCatalog {
  abstract read(
    file: LibraryFile,
    tx: Prisma.TransactionClient,
  ): Promise<VideoProcessingSnapshot>;
}
@Injectable()
export class SourceOnlyVideoCatalog extends VideoRenditionCatalog {
  async read(): Promise<VideoProcessingSnapshot> {
    return { status: "NOT_REQUESTED", progressPercent: null, renditions: [] };
  }
}
