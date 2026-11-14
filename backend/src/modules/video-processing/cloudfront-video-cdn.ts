import { createSign } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { ApiError } from "../../common/api-error";
import { objectKey, type VideoOutput } from "./video-policy";
import type { VideoConfig } from "./video-config";
import type { StorageTarget } from "../files/storage-locations.service";
import type { MediaGrant, VideoCdnProvider } from "./video-cdn";

const cloudBase64 = (value: Buffer) =>
  value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/=/g, "_")
    .replace(/\//g, "~");

export class CloudFrontVideoCdn implements VideoCdnProvider {
  private secret?: { keyPairId: string; privateKey: string; expires: number };
  constructor(private readonly config: VideoConfig) {}
  supports(target: StorageTarget) {
    return (
      target.driver === "s3" &&
      target.bucket === this.config.outputBucket &&
      target.region === this.config.region
    );
  }
  async grant(
    fileId: string,
    output: VideoOutput,
    expires: number,
  ): Promise<MediaGrant> {
    const video = this.config;
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
      expiresAt: new Date(expires * 1000).toISOString(),
      assetUrl: (key) => {
        objectKey(key);
        if (!key.startsWith(output.prefix + "/"))
          throw new Error("VIDEO_OUTPUT_INVALID");
        return `https://${domain}/${key}`;
      },
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
}
