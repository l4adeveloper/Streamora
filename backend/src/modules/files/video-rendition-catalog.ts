import { Injectable } from "@nestjs/common";
import type { VideoProcessingStatus } from "@streamora/contracts";
import type { LibraryFile, Prisma } from "../../generated/prisma/client";

export interface VideoProcessingSnapshot {
  status: VideoProcessingStatus;
  progressPercent: number | null;
  // AWS encoder outputs (wired by T13 later). Only fully published objects are ready.
  renditions: {
    id: string;
    height: number;
    bitrate: number;
    mimeType: string;
    objectKey: string;
    storageLocationId?: string;
  }[];
  // T13/T14 must authorize the entire HLS tree, including playlists and segments.
  // A presigned master.m3u8 alone is not a playable private HLS delivery solution.
  hls?: { url: string; expiresAt: string };
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
