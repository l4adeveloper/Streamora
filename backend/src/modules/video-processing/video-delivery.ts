import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { ApiError } from "../../common/api-error";
import { objectKey, type VideoOutput } from "./video-policy";
import { StorageLocationsService } from "../files/storage-locations.service";

import {
  VIDEO_CDN_PROVIDERS,
  type MediaGrant,
  type VideoCdnProvider,
} from "./video-cdn";
import { CloudFrontVideoCdn } from "./cloudfront-video-cdn";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { signCloudFrontUrl } from "./cloudfront-signed-url";
export type { DeliveryCookie, MediaGrant } from "./video-cdn";

@Injectable()
export class VideoDelivery {
  private readonly providers: VideoCdnProvider[];
  private signingKey?: Promise<string>;
  constructor(
    @Inject(APP_CONFIG) readonly config: EnvironmentConfig,
    @Optional() private readonly locations?: StorageLocationsService,
    @Optional() @Inject(VIDEO_CDN_PROVIDERS) providers?: VideoCdnProvider[],
  ) {
    this.providers =
      providers ?? (config.video ? [new CloudFrontVideoCdn(config.video)] : []);
  }
  private sign(payload: string) {
    return createHmac("sha256", this.config.auth.accessTokenSecret)
      .update("video-grant.v1:" + payload)
      .digest("base64url");
  }
  private async privateKey() {
    if (!this.signingKey) {
      this.signingKey = (async () => {
        const video = this.config.video;
        if (!video?.cloudFrontSigningSecretId)
          throw new ApiError(
            503,
            "VIDEO_DELIVERY_UNAVAILABLE",
            "Chưa cấu hình khóa ký CDN.",
          );
        const client = new SecretsManagerClient({ region: video.region });
        try {
          const secret = await client.send(
            new GetSecretValueCommand({
              SecretId: video.cloudFrontSigningSecretId,
            }),
          );
          if (!secret.SecretString?.includes("BEGIN PRIVATE KEY"))
            throw new Error("INVALID_SIGNING_KEY");
          return secret.SecretString;
        } finally {
          client.destroy();
        }
      })().catch((error) => {
        this.signingKey = undefined;
        throw error;
      });
    }
    return this.signingKey;
  }
  async signedObjectUrl(
    key: string,
    expires = Math.floor(Date.now() / 1000) + 900,
  ) {
    return (await this.signedObjectFactory(expires))(key);
  }
  async signedObjectFactory(expires: number) {
    const video = this.config.video;
    if (!video?.mediaDomain || !video.cloudFrontKeyPairId)
      throw new ApiError(
        503,
        "VIDEO_DELIVERY_UNAVAILABLE",
        "Chưa cấu hình CDN private.",
      );
    const signingKey = await this.privateKey();
    return (key: string) => {
      objectKey(key);
      return signCloudFrontUrl(
        `https://${video.mediaDomain}/${key}`,
        video.cloudFrontKeyPairId,
        signingKey,
        expires,
      );
    };
  }
  async grant(
    fileId: string,
    jobId: string,
    output: VideoOutput,
  ): Promise<MediaGrant> {
    const expires = Math.floor(Date.now() / 1000) + 60,
      expiresAt = new Date(expires * 1000).toISOString();
    objectKey(output.prefix);
    objectKey(output.masterKey);
    const target = await this.locations?.resolve(output.storageLocationId);
    if (this.config.video?.mode !== "aws" || target?.driver === "local") {
      const path = `/api/v1/video-media/${fileId}/${jobId}`;
      const payload = Buffer.from(
        JSON.stringify({
          fileId,
          jobId,
          location: output.storageLocationId,
          prefix: output.prefix,
          expires,
        }),
      ).toString("base64url");
      const base =
        this.config.files?.publicBaseUrl ??
        `http://127.0.0.1:${this.config.port}`;
      return {
        url:
          base + path + "/" + output.masterKey.slice(output.prefix.length + 1),
        expiresAt,
        assetUrl: (key) => {
          objectKey(key);
          if (!key.startsWith(output.prefix + "/"))
            throw new Error("VIDEO_OUTPUT_INVALID");
          return base + path + "/" + key.slice(output.prefix.length + 1);
        },
        cookies: [
          {
            name: "video_grant",
            value: payload + "." + this.sign(payload),
            path,
            secure: this.config.auth.cookie.secure,
          },
        ],
      };
    }
    const source = target ?? {
      driver: "s3" as const,
      bucket: this.config.video?.outputBucket ?? "",
      region: this.config.video?.region ?? "",
    };
    if (
      this.config.video?.cloudFrontKeyPairId &&
      source.driver === "s3" &&
      source.bucket === this.config.video.outputBucket &&
      source.region === this.config.video.region
    ) {
      // Playlists are served through the authenticated API and rewritten there;
      // media objects and thumbnails get individual CloudFront signatures.
      const signingKey = await this.privateKey();
      const path = `/api/v1/video-media/${fileId}/${jobId}`;
      const payload = Buffer.from(
        JSON.stringify({
          fileId,
          jobId,
          location: output.storageLocationId,
          prefix: output.prefix,
          expires,
        }),
      ).toString("base64url");
      const playlistUrl = (key: string) =>
        `${path}/${key.slice(output.prefix.length + 1)}`;
      const assetUrl = (key: string) => {
        objectKey(key);
        if (!key.startsWith(output.prefix + "/"))
          throw new Error("VIDEO_OUTPUT_INVALID");
        return key.endsWith(".m3u8")
          ? playlistUrl(key)
          : signCloudFrontUrl(
              `https://${this.config.video!.mediaDomain}/${key}`,
              this.config.video!.cloudFrontKeyPairId,
              signingKey,
              expires + 840,
            );
      };
      return {
        url: playlistUrl(output.masterKey),
        expiresAt,
        assetUrl,
        cookies: [
          {
            name: "video_grant",
            value: payload + "." + this.sign(payload),
            path,
            secure: this.config.auth.cookie.secure,
          },
        ],
      };
    }
    const provider = this.providers.find((candidate) =>
      candidate.supports(source),
    );
    if (!provider)
      throw new ApiError(
        503,
        "VIDEO_DELIVERY_UNAVAILABLE",
        "Vị trí video chưa được gắn vào CDN.",
      );
    return provider.grant(fileId, output, expires);
  }
  verify(token: string, fileId: string, jobId: string) {
    try {
      if (typeof token !== "string" || token.length > 8192) throw new Error();
      const [payload, signature, ...extra] = token.split(".");
      const expected = Buffer.from(this.sign(payload));
      const actual = Buffer.from(signature ?? "");
      if (
        extra.length ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error();
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (
        value.fileId !== fileId ||
        value.jobId !== jobId ||
        value.expires <= Date.now() / 1000 ||
        value.expires > Date.now() / 1000 + 60 ||
        !/^[a-f0-9]{64}$/.test(value.location)
      )
        throw new Error();
      objectKey(value.prefix);
      return value as { location: string; prefix: string };
    } catch {
      throw new ApiError(
        403,
        "VIDEO_GRANT_INVALID",
        "Quyền xem video không hợp lệ hoặc đã hết hạn.",
      );
    }
  }
}
