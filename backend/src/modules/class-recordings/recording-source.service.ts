import { Inject, Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ApiError } from "../../common/api-error";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import { FilesService } from "../files/files.service";
import { RecordingPlaybackService } from "./recording-playback.service";
import {
  VideoDelivery,
  type DeliveryCookie,
} from "../video-processing/video-delivery";
import { VideoStorage } from "../video-processing/video-storage";
import { VideoProcessingService } from "../video-processing/video-processing.service";
import {
  objectKey,
  qualityLabel,
  type VideoOutput,
} from "../video-processing/video-policy";
import { GcsReplicaStorage } from "../video-processing/gcs-replica-storage";
import { rewriteSignedHlsPlaylist } from "../video-processing/signed-hls-playlist";

type SourceId = "cloudfront" | "gcs";
type Candidate = { id: SourceId; sign: (key: string) => string };
type Grant = {
  userId: string;
  recordingId: string;
  jobId: string;
  sourceId: SourceId;
  expires: number;
};

@Injectable()
export class RecordingSourceService {
  // This cache is keyed by immutable output version. Client failure hints never
  // change global health, and there is no database-controlled fetch destination.
  private readonly health = new Map<
    string,
    { until: number; healthy: boolean }
  >();
  private readonly gcs: GcsReplicaStorage;
  constructor(
    private readonly db: PrismaService,
    private readonly recordings: RecordingPlaybackService,
    private readonly files: FilesService,
    private readonly processing: VideoProcessingService,
    private readonly delivery: VideoDelivery,
    private readonly storage: VideoStorage,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {
    this.gcs = new GcsReplicaStorage(config.video?.gcsDelivery?.projectId);
  }

  private async published(userId: string, recordingId: string) {
    const recording = await this.recordings.recording(userId, recordingId);
    if (
      recording.status !== "SAVED" ||
      recording.file?.status !== "AVAILABLE" ||
      !recording.fileId
    )
      throw new ApiError(
        409,
        "PLAYBACK_NOT_READY",
        "Bản ghi chưa sẵn sàng để phát.",
      );
    const { published } = await this.processing.state(recording.fileId);
    return { recording, published };
  }

  private output(value: unknown) {
    const output = value as VideoOutput;
    try {
      objectKey(output?.prefix);
      objectKey(output.masterKey);
      if (
        !output.masterKey.startsWith(output.prefix + "/") ||
        !output.masterKey.endsWith(".m3u8") ||
        !/^[a-f0-9]{64}$/.test(output.storageLocationId) ||
        !Number.isFinite(output.duration) ||
        output.duration <= 0 ||
        !Array.isArray(output.renditions) ||
        !output.renditions.length
      )
        throw new Error();
      for (const rendition of output.renditions) {
        objectKey(rendition.variantKey);
        if (
          !rendition.variantKey.startsWith(output.prefix + "/") ||
          !rendition.variantKey.endsWith(".m3u8") ||
          !Number.isFinite(rendition.width) ||
          rendition.width <= 0 ||
          !Number.isFinite(rendition.height) ||
          rendition.height <= 0 ||
          !Number.isFinite(rendition.bitrate) ||
          rendition.bitrate <= 0
        )
          throw new Error();
      }
      if (output.thumbnailKey) {
        objectKey(output.thumbnailKey);
        if (!output.thumbnailKey.startsWith(output.prefix + "/"))
          throw new Error();
      }
      return output;
    } catch {
      throw new ApiError(
        503,
        "VIDEO_OUTPUT_INVALID",
        "Dữ liệu video chưa sẵn sàng.",
      );
    }
  }

  private async replica(fileId: string, jobId: string, output: VideoOutput) {
    const bucket = this.config.video?.gcsDelivery?.bucket;
    if (!bucket) return false;
    const row = await this.db.videoReplica.findUnique({
      where: { jobId_destinationBucket: { jobId, destinationBucket: bucket } },
    });
    // A stale/partial replica must never become a playback candidate. Compare
    // the version snapshot as well as the job FK and successful completion.
    return (
      !!row &&
      row.fileId === fileId &&
      row.status === "READY" &&
      row.objectCount > 0 &&
      !!row.lastSyncedAt &&
      isDeepStrictEqual(row.output, output)
    );
  }

  private async candidates(
    fileId: string,
    jobId: string,
    output: VideoOutput,
    expires: number,
  ) {
    const choices: Candidate[] = [];
    const video = this.config.video;
    try {
      const target = await this.storage.locations.resolve(
        output.storageLocationId,
      );
      if (
        video?.cloudFrontKeyPairId &&
        target.driver === "s3" &&
        target.bucket === video.outputBucket &&
        target.region === video.region
      )
        choices.push({
          id: "cloudfront",
          sign: await this.delivery.signedObjectFactory(expires),
        });
    } catch {
      /* Try the independently configured replica. */
    }
    if (await this.replica(fileId, jobId, output)) {
      try {
        choices.push({
          id: "gcs",
          sign: await this.delivery.gcsSignedObjectFactory(expires),
        });
      } catch {
        /* Fail closed if the key cannot be loaded. */
      }
    }
    return choices;
  }

  private async healthy(candidate: Candidate, jobId: string, key: string) {
    const cacheKey = `${candidate.id}:${jobId}`;
    const previous = this.health.get(cacheKey);
    if (previous && previous.until > Date.now()) return previous.healthy;
    let healthy = false;
    try {
      const response = await fetch(candidate.sign(key), {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(2500),
      });
      healthy = response.ok;
      await response.body?.cancel();
    } catch {
      /* Availability failure, never an authorization override. */
    }
    if (this.health.size >= 256)
      this.health.delete(this.health.keys().next().value!);
    this.health.set(cacheKey, {
      healthy,
      until: Date.now() + (healthy ? 10000 : 3000),
    });
    return healthy;
  }

  private signature(payload: string) {
    return createHmac("sha256", this.config.auth.accessTokenSecret)
      .update("recording-grant.v1:" + payload)
      .digest("base64url");
  }
  private grant(value: Grant) {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return payload + "." + this.signature(payload);
  }
  private verify(
    token: unknown,
    recordingId: string,
    jobId: string,
    sourceId: string,
  ): Grant {
    try {
      if (typeof token !== "string" || token.length > 4096) throw new Error();
      const [payload, signature, ...extra] = token.split(".");
      const expected = Buffer.from(this.signature(payload));
      const actual = Buffer.from(signature ?? "");
      if (
        extra.length ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const grant = JSON.parse(
        Buffer.from(payload, "base64url").toString(),
      ) as Grant;
      if (
        grant.recordingId !== recordingId ||
        grant.jobId !== jobId ||
        grant.sourceId !== sourceId ||
        !["cloudfront", "gcs"].includes(sourceId) ||
        !/^[a-f0-9-]{36}$/.test(grant.userId) ||
        !Number.isSafeInteger(grant.expires) ||
        grant.expires <= Date.now() / 1000 ||
        grant.expires > Date.now() / 1000 + 60
      )
        throw new Error();
      return grant;
    } catch {
      throw new ApiError(
        403,
        "VIDEO_GRANT_INVALID",
        "Quyền phát video không hợp lệ hoặc hết hạn.",
      );
    }
  }

  async resolve(
    userId: string,
    recordingId: string,
    body: {
      mode?: unknown;
      failedSourceId?: unknown;
      preferredSourceId?: unknown;
      positionSeconds?: unknown;
    },
  ) {
    if (
      !body ||
      !["VOD", "LIVE_DVR"].includes(body.mode as string) ||
      (body.failedSourceId !== undefined &&
        !["cloudfront", "gcs", "original", "local"].includes(
          body.failedSourceId as string,
        )) ||
      (body.preferredSourceId !== undefined &&
        !["cloudfront", "gcs", "original", "local"].includes(
          body.preferredSourceId as string,
        )) ||
      (body.positionSeconds !== undefined &&
        (typeof body.positionSeconds !== "number" ||
          !Number.isFinite(body.positionSeconds) ||
          body.positionSeconds < 0))
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Yêu cầu phát video không hợp lệ.",
      );
    const { recording, published } = await this.published(userId, recordingId);
    if (body.mode === "LIVE_DVR")
      throw new ApiError(
        409,
        "PLAYBACK_NOT_READY",
        "Nguồn phát trực tiếp chưa sẵn sàng.",
      );
    if (
      this.config.video?.mode !== "aws" ||
      (!this.config.video.cloudFrontKeyPairId &&
        !this.config.video.gcsDelivery) ||
      !published?.output ||
      published.state !== "READY"
    ) {
      const playback = await this.files.playback(userId, recording.fileId!);
      return {
        ...playback,
        sourceId: "original",
        manifestUrl:
          playback.sources.find((s) => s.kind === "hls")?.url ??
          playback.sources[0]?.url ??
          null,
        authorization: {
          type: "SIGNED_URL" as const,
          expiresAt: playback.sources[0]?.expiresAt ?? null,
        },
        fallbackAvailable: false,
      };
    }
    const output = this.output(published.output);
    if (
      typeof body.positionSeconds === "number" &&
      body.positionSeconds > output.duration
    )
      throw new ApiError(
        400,
        "INVALID_POSITION",
        "Vị trí xem vượt thời lượng bản ghi.",
      );
    const expires = Math.floor(Date.now() / 1000) + 60;
    const choices = await this.candidates(
      recording.fileId!,
      published.id,
      output,
      expires + 840,
    );
    const available = (
      await Promise.all(
        choices.map(async (choice) =>
          (await this.healthy(choice, published.id, output.masterKey))
            ? choice
            : null,
        ),
      )
    ).filter((choice): choice is Candidate => !!choice);
    const selected = body.failedSourceId
      ? (available.find((choice) => choice.id !== body.failedSourceId) ??
        available[0])
      : (available.find((choice) => choice.id === body.preferredSourceId) ??
        available[0]);
    if (!selected)
      throw new ApiError(
        503,
        "PLAYBACK_SOURCE_UNAVAILABLE",
        "Chưa có nguồn video khả dụng. Hãy thử lại sau.",
      );
    const base = `/api/v1/recording-media/${recordingId}/${published.id}/${selected.id}`;
    const playlist = (key: string) =>
      base + "/" + key.slice(output.prefix.length + 1);
    const expiresAt = new Date(expires * 1000).toISOString();
    const cookie: DeliveryCookie = {
      name: "recording_grant",
      value: this.grant({
        userId,
        recordingId,
        jobId: published.id,
        sourceId: selected.id,
        expires,
      }),
      path: base,
      secure: this.config.auth.cookie.secure,
    };
    return {
      fileId: recording.fileId!,
      sourceId: selected.id,
      manifestUrl: playlist(output.masterKey),
      authorization: {
        type: "SIGNED_URL" as const,
        expiresAt: new Date((expires + 840) * 1000).toISOString(),
      },
      fallbackAvailable: available.some((choice) => choice.id !== selected.id),
      processing: { status: "READY" as const, progressPercent: 100 },
      sources: [
        {
          id: "adaptive",
          label: "Tự động",
          kind: "hls" as const,
          mimeType: "application/vnd.apple.mpegurl",
          height: null,
          bitrate: null,
          url: playlist(output.masterKey),
          expiresAt,
        },
      ],
      qualities: output.renditions.map((r) => ({
        id: r.id,
        width: r.width,
        height: r.height,
        bitrate: r.bitrate,
        label: qualityLabel(r.width, r.height),
        url: playlist(r.variantKey),
        expiresAt,
      })),
      ...(output.thumbnailKey
        ? { thumbnail: selected.sign(output.thumbnailKey) }
        : {}),
      deliveryCookies: [cookie],
    };
  }

  async playlist(
    recordingId: string,
    jobId: string,
    sourceId: string,
    path: string[],
    token: unknown,
  ) {
    const grant = this.verify(token, recordingId, jobId, sourceId);
    const { recording, published } = await this.published(
      grant.userId,
      recordingId,
    );
    if (
      published?.id !== jobId ||
      published.state !== "READY" ||
      !published.output
    )
      throw new ApiError(
        409,
        "PLAYBACK_NOT_READY",
        "Phiên bản phát video đã thay đổi.",
      );
    const output = this.output(published.output);
    const key =
      output.prefix + "/" + (Array.isArray(path) ? path.join("/") : path);
    try {
      objectKey(key);
    } catch {
      throw new ApiError(403, "FORBIDDEN", "Đường dẫn video không hợp lệ.");
    }
    if (!key.endsWith(".m3u8"))
      throw new ApiError(403, "FORBIDDEN", "Đường dẫn video không hợp lệ.");
    const choices = await this.candidates(
      recording.fileId!,
      jobId,
      output,
      Math.floor(Date.now() / 1000) + 900,
    );
    const selected = choices.find((choice) => choice.id === sourceId);
    if (!selected)
      throw new ApiError(
        503,
        "PLAYBACK_SOURCE_UNAVAILABLE",
        "Nguồn phát video chưa sẵn sàng.",
      );
    try {
      const text =
        sourceId === "gcs"
          ? await this.gcs.text(this.config.video!.gcsDelivery!.bucket, key)
          : await this.storage.text(output.storageLocationId, key);
      const base = `/api/v1/recording-media/${recordingId}/${jobId}/${sourceId}/`;
      return rewriteSignedHlsPlaylist(
        text,
        key,
        output.prefix,
        (child) => base + child.slice(output.prefix.length + 1),
        selected.sign,
      );
    } catch {
      throw new ApiError(
        503,
        "PLAYBACK_SOURCE_UNAVAILABLE",
        "Không tải được danh sách phát video.",
      );
    }
  }
}
