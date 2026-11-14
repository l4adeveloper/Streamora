import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { ApiError } from "../../common/api-error";
import { objectKey, type VideoOutput } from "./video-policy";
import { StorageLocationsService } from "../files/storage-locations.service";

export interface DeliveryCookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  secure: boolean;
}
export interface MediaGrant {
  url: string;
  expiresAt: string;
  cookies: DeliveryCookie[];
  grantUrl?: string;
}
const cloudBase64 = (value: Buffer) =>
  value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/=/g, "_")
    .replace(/\//g, "~");
@Injectable()
export class VideoDelivery {
  private secret?: { keyPairId: string; privateKey: string; expires: number };
  constructor(
    @Inject(APP_CONFIG) readonly config: EnvironmentConfig,
    @Optional() private readonly locations?: StorageLocationsService,
  ) {}
  private sign(payload: string) {
    return createHmac("sha256", this.config.auth.accessTokenSecret)
      .update("video-grant.v1:" + payload)
      .digest("base64url");
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
    if (
      target ? target.driver === "local" : this.config.video?.mode !== "aws"
    ) {
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
    if (
      target?.driver === "s3" &&
      target.bucket !== this.config.video?.outputBucket
    )
      throw new ApiError(
        503,
        "VIDEO_DELIVERY_UNAVAILABLE",
        "Vị trí video chưa được gắn vào media CDN.",
      );
    const video = this.config.video;
    const domain = video?.mediaDomain;
    if (!domain)
      throw new ApiError(
        503,
        "VIDEO_DELIVERY_UNAVAILABLE",
        "Chưa cấu hình phân phối video.",
      );
    if (!this.secret || this.secret.expires < Date.now()) {
      const client = new SecretsManagerClient({ region: video!.region });
      try {
        const result = await client.send(
          new GetSecretValueCommand({ SecretId: video!.signingSecretArn }),
        );
        const secret = JSON.parse(result.SecretString ?? "{}");
        if (!secret.keyPairId || !secret.privateKey) throw new Error();
        this.secret = { ...secret, expires: Date.now() + 300000 };
      } catch {
        throw new ApiError(
          503,
          "VIDEO_DELIVERY_UNAVAILABLE",
          "Chưa thể cấp quyền phát video.",
        );
      } finally {
        client.destroy();
      }
    }
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: `https://${domain}/${output.prefix}/*`,
          Condition: { DateLessThan: { "AWS:EpochTime": expires } },
        },
      ],
    });
    const signature = createSign("RSA-SHA1")
      .update(policy)
      .sign(this.secret!.privateKey);
    return {
      url: `https://${domain}/${output.masterKey}`,
      expiresAt,
      grantUrl: `https://${domain}/api/v1/files/${fileId}/media-grant`,
      cookies: [
        { name: "CloudFront-Policy", value: cloudBase64(Buffer.from(policy)) },
        { name: "CloudFront-Signature", value: cloudBase64(signature) },
        { name: "CloudFront-Key-Pair-Id", value: this.secret!.keyPairId },
      ].map((c) => ({
        ...c,
        path: "/" + output.prefix + "/",
        domain,
        secure: true,
      })),
    };
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
