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
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  planLiveReplication,
  type LiveSnapshot,
} from "../video-processing/live-replication-plan";
import { reference } from "../video-processing/video-finalizer";

type SourceId = "cloudfront" | "gcs";
type Candidate = { id: SourceId; sign: (key: string) => string };
type Grant = {
  userId: string;
  recordingId: string;
  jobId: string;
  sourceId: SourceId | "original";
  expires: number;
  mode?: "LIVE_DVR";
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

  private async healthy(
    candidate: { id: string; sign: (key: string) => string },
    jobId: string,
    key: string,
  ) {
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
        !["cloudfront", "gcs", "original"].includes(sourceId) ||
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
      viewerRegion?: unknown;
    },
  ) {
    if (
      !body ||
      !["VOD", "LIVE_DVR"].includes(body.mode as string) ||
      (body.viewerRegion !== undefined &&
        (typeof body.viewerRegion !== "string" ||
          !/^[A-Z][A-Z0-9_-]{1,31}$/.test(body.viewerRegion))) ||
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
    if (body.mode === "LIVE_DVR")
      return this.resolveLive(userId, recordingId, body);
    const { recording, published } = await this.published(userId, recordingId);
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
    const regional =
      this.config.video?.sourceRegionPreferences?.[body.viewerRegion as string];
    available.sort(
      (a, b) => Number(b.id === regional) - Number(a.id === regional),
    );
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
    if (grant.mode === "LIVE_DVR") {
      if (jobId !== recordingId || !["original", "gcs"].includes(sourceId))
        throw new ApiError(
          403,
          "VIDEO_GRANT_INVALID",
          "Quyền phát video không hợp lệ.",
        );
      const live = await this.liveSnapshot(grant.userId, recordingId, sourceId);
      const key =
        live.snapshot.prefix +
        "/" +
        (Array.isArray(path) ? path.join("/") : path);
      objectKey(key);
      const text = Object.hasOwn(live.snapshot.playlists, key)
        ? live.snapshot.playlists[key]
        : undefined;
      if (!text)
        throw new ApiError(403, "FORBIDDEN", "Đường dẫn video không hợp lệ.");
      const media = [
        ...text.matchAll(/(?:URI="([^"]+)"|^([^#\r\n][^\r\n]*))/gm),
      ]
        .map((m) => reference(key, (m[1] ?? m[2]).trim(), live.snapshot.prefix))
        .filter((k) => !k.endsWith(".m3u8"));
      const sign = await this.liveSigner(live, sourceId, media);
      const base = `/api/v1/recording-media/${recordingId}/${recordingId}/${sourceId}/`;
      return rewriteSignedHlsPlaylist(
        text,
        key,
        live.snapshot.prefix,
        (child) => base + child.slice(live.snapshot.prefix.length + 1),
        sign,
      );
    }
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

  private async liveSnapshot(
    userId: string,
    recordingId: string,
    sourceId: string,
  ) {
    const recording = await this.recordings.recording(userId, recordingId);
    if (
      recording.provider !== "IVS" ||
      !["RECORDING", "SAVING", "SAVED"].includes(recording.status) ||
      !recording.recordingPrefix ||
      !recording.storageLocationId
    )
      throw new ApiError(
        409,
        "PLAYBACK_NOT_READY",
        "Nguồn tua lại chưa sẵn sàng.",
      );
    const prefix = recording.recordingPrefix;
    if (sourceId === "gcs") {
      const bucket = this.config.video?.gcsDelivery?.bucket;
      if (!bucket)
        throw new ApiError(
          503,
          "PLAYBACK_SOURCE_UNAVAILABLE",
          "Nguồn sao chép chưa sẵn sàng.",
        );
      const row = await this.db.storageReplica.findUnique({
        where: {
          kind_assetId_destinationBucket: {
            kind: "LIVE_DVR",
            assetId: recordingId,
            destinationBucket: bucket,
          },
        },
      });
      const source = row?.source as
        { prefix?: string; storageLocationId?: string } | undefined;
      const snapshot = row?.snapshot as unknown as LiveSnapshot & {
        destinationPrefix: string;
      };
      if (
        !row?.lastSyncedAt ||
        !snapshot ||
        row.objectCount <= 0 ||
        row.readyThroughSeconds <= 0 ||
        snapshot.prefix !== prefix ||
        snapshot.destinationPrefix !== `replicas/live/${recordingId}` ||
        source?.prefix !== prefix ||
        source?.storageLocationId !== recording.storageLocationId
      )
        throw new ApiError(
          503,
          "PLAYBACK_SOURCE_UNAVAILABLE",
          "Nguồn sao chép chưa sẵn sàng.",
        );
      return {
        recording,
        snapshot,
        destinationPrefix: snapshot.destinationPrefix,
      };
    }
    const listed = await this.storage.list(recording.storageLocationId, prefix);
    const keys = [...listed].filter((k) => k.endsWith(".m3u8"));
    if (keys.length > 64)
      throw new ApiError(
        503,
        "PLAYBACK_SOURCE_UNAVAILABLE",
        "Nguồn tua lại chưa sẵn sàng.",
      );
    const masters: string[] = [];
    for (const key of keys)
      if (
        (await this.storage.text(recording.storageLocationId, key)).includes(
          "#EXT-X-STREAM-INF:",
        )
      )
        masters.push(key);
    if (masters.length !== 1)
      throw new ApiError(
        409,
        "PLAYBACK_NOT_READY",
        "Nguồn tua lại chưa sẵn sàng.",
      );
    const snapshot = await planLiveReplication(prefix, masters[0], (key) =>
      this.storage.text(recording.storageLocationId!, key),
    );
    if (snapshot.objects.some((key) => !listed.has(key)))
      throw new ApiError(
        409,
        "PLAYBACK_NOT_READY",
        "Nguồn tua lại chưa sẵn sàng.",
      );
    return { recording, snapshot, destinationPrefix: "" };
  }

  private async liveSigner(
    live: Awaited<ReturnType<RecordingSourceService["liveSnapshot"]>>,
    sourceId: string,
    objects = live.snapshot.objects.slice(0, 1),
    head = false,
  ) {
    if (sourceId === "gcs") {
      const sign = await this.delivery.gcsSignedObjectFactory(
        Math.floor(Date.now() / 1000) + 900,
      );
      return (key: string) =>
        sign(
          live.destinationPrefix +
            "/" +
            key.slice(live.snapshot.prefix.length + 1),
        );
    }
    const target = await this.storage.locations.resolve(
      live.recording.storageLocationId!,
    );
    if (target.driver !== "s3")
      throw new ApiError(
        503,
        "PLAYBACK_SOURCE_UNAVAILABLE",
        "Nguồn tua lại chưa sẵn sàng.",
      );
    const client = new S3Client({ region: target.region });
    try {
      const signed = new Map<string, string>();
      // Bound concurrent credential/signing work for long event playlists.
      for (let i = 0; i < objects.length; i += 50) {
        await Promise.all(
          objects.slice(i, i + 50).map(async (key) => {
            signed.set(
              key,
              await getSignedUrl(
                client,
                head
                  ? new HeadObjectCommand({ Bucket: target.bucket, Key: key })
                  : new GetObjectCommand({ Bucket: target.bucket, Key: key }),
                { expiresIn: 900 },
              ),
            );
          }),
        );
      }
      return (key: string) => {
        const url = signed.get(key);
        if (!url)
          throw new ApiError(403, "FORBIDDEN", "Đường dẫn video không hợp lệ.");
        return url;
      };
    } finally {
      client.destroy();
    }
  }

  private async resolveLive(
    userId: string,
    recordingId: string,
    body: {
      failedSourceId?: unknown;
      preferredSourceId?: unknown;
      positionSeconds?: unknown;
      viewerRegion?: unknown;
    },
  ) {
    // Authorize before probing either storage provider.
    const recording = await this.recordings.recording(userId, recordingId);
    if (
      recording.provider !== "IVS" ||
      !recording.recordingPrefix ||
      !recording.storageLocationId ||
      !["RECORDING", "SAVING", "SAVED"].includes(recording.status)
    )
      throw new ApiError(
        409,
        "PLAYBACK_NOT_READY",
        "Nguồn tua lại chưa sẵn sàng.",
      );
    const available: {
      id: string;
      live: Awaited<ReturnType<RecordingSourceService["liveSnapshot"]>>;
    }[] = [];
    const results = await Promise.allSettled(
      ["original", "gcs"].map(async (id) => {
        const live = await this.liveSnapshot(userId, recordingId, id);
        const sign = await this.liveSigner(live, id, undefined, true);
        const healthy = await this.healthy(
          { id, sign },
          "live:" + recordingId,
          live.snapshot.objects[0],
        );
        if (!healthy)
          throw new ApiError(
            503,
            "PLAYBACK_SOURCE_UNAVAILABLE",
            "Nguồn tua lại chưa sẵn sàng.",
          );
        return { id, live };
      }),
    );
    for (const result of results)
      if (
        result.status === "fulfilled" &&
        (typeof body.positionSeconds !== "number" ||
          body.positionSeconds < result.value.live.snapshot.readyThroughSeconds)
      )
        available.push(result.value);
    const regional =
      this.config.video?.sourceRegionPreferences?.[body.viewerRegion as string];
    const preferred =
      body.preferredSourceId ?? (regional === "gcs" ? "gcs" : "original");
    available.sort(
      (a, b) => Number(b.id === preferred) - Number(a.id === preferred),
    );
    const selected = available.find(
      (choice) => choice.id !== body.failedSourceId,
    );
    if (!selected)
      throw new ApiError(
        503,
        "PLAYBACK_SOURCE_UNAVAILABLE",
        "Chưa có nguồn tua lại khả dụng tại vị trí này.",
      );
    const expires = Math.floor(Date.now() / 1000) + 60;
    const base = `/api/v1/recording-media/${recordingId}/${recordingId}/${selected.id}`;
    const url =
      base +
      "/" +
      selected.live.snapshot.masterKey.slice(
        selected.live.snapshot.prefix.length + 1,
      );
    return {
      fileId: selected.live.recording.fileId ?? recordingId,
      sourceId: selected.id,
      manifestUrl: url,
      mode: "LIVE_DVR" as const,
      readyThroughSeconds: selected.live.snapshot.readyThroughSeconds,
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
          url,
          expiresAt: new Date(expires * 1000).toISOString(),
        },
      ],
      qualities: [],
      thumbnail: undefined,
      deliveryCookies: [
        {
          name: "recording_grant",
          value: this.grant({
            userId,
            recordingId,
            jobId: recordingId,
            sourceId: selected.id as "gcs" | "original",
            expires,
            mode: "LIVE_DVR",
          }),
          path: base,
          secure: this.config.auth.cookie.secure,
        },
      ],
    };
  }
}
