import { Injectable } from "@nestjs/common";
import type { LibraryFile, Prisma } from "../../generated/prisma/client";
import {
  VideoRenditionCatalog,
  type VideoProcessingSnapshot,
} from "../files/video-rendition-catalog";
import { VideoProcessingService } from "./video-processing.service";
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
    const status = await this.service.snapshot(file.id, tx);
    const asset = await tx.videoAsset.findUnique({
      where: { fileId: file.id },
    });
    const published = asset?.publishedJobId
      ? await tx.videoJob.findUnique({ where: { id: asset.publishedJobId } })
      : null;
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
