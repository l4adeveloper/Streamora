import { Injectable } from "@nestjs/common";
import type { LibraryFile, Prisma } from "../../generated/prisma/client";
import {
  VideoRenditionCatalog,
  type VideoProcessingSnapshot,
} from "../files/video-rendition-catalog";
import {
  VideoProcessingService,
  processingSnapshot,
} from "./video-processing.service";
import { VideoDelivery } from "./video-delivery";
import { qualityLabel, type VideoOutput } from "./video-policy";

@Injectable()
export class DatabaseVideoCatalog extends VideoRenditionCatalog {
  constructor(
    private readonly service: VideoProcessingService,
    private readonly delivery: VideoDelivery,
  ) {
    super();
  }
  async read(
    file: LibraryFile,
    tx: Prisma.TransactionClient,
  ): Promise<VideoProcessingSnapshot> {
    const { asset, job, published } = await this.service.state(file.id, tx);
    const status = processingSnapshot(job, published);
    const result: VideoProcessingSnapshot = {
      ...status,
      renditions: [],
      hasOriginal: !asset || (asset.source as { kind: string }).kind === "FILE",
    };
    if (published?.state === "READY" && published.output) {
      const output = published.output as unknown as VideoOutput;
      const grant = await this.delivery.grant(file.id, published.id, output);
      result.hls = { url: grant.url, expiresAt: grant.expiresAt };
      result.deliveryCookies = grant.cookies;
      result.grantUrl = grant.grantUrl;
      result.qualities = output.renditions
        .map((r) => ({
          id: r.id,
          width: r.width,
          height: r.height,
          bitrate: r.bitrate,
          label: qualityLabel(r.width, r.height),
          url: grant.assetUrl(r.variantKey),
          expiresAt: grant.expiresAt,
        }))
        .sort(
          (a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height),
        );
      if (output.thumbnailKey)
        result.thumbnail = grant.assetUrl(output.thumbnailKey);
    }
    return result;
  }
}
