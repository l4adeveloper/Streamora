import { ApiError } from "../../common/api-error";
import { objectKey, type VideoOutput } from "./video-policy";
import type { VideoConfig } from "./video-config";
import type { StorageTarget } from "../files/storage-locations.service";
import type { MediaGrant, VideoCdnProvider } from "./video-cdn";

// CloudFront serves the output publicly; S3 itself remains private behind OAC.
export class CloudFrontVideoCdn implements VideoCdnProvider {
  constructor(private readonly config: VideoConfig) {}
  supports(target: StorageTarget) {
    return (
      target.driver === "s3" &&
      target.bucket === this.config.outputBucket &&
      target.region === this.config.region
    );
  }
  async grant(
    _fileId: string,
    output: VideoOutput,
    expires: number,
  ): Promise<MediaGrant> {
    const domain = this.config.mediaDomain;
    if (!domain)
      throw new ApiError(
        503,
        "VIDEO_DELIVERY_UNAVAILABLE",
        "Chưa cấu hình phân phối video.",
      );
    const assetUrl = (key: string) => {
      objectKey(key);
      if (!key.startsWith(output.prefix + "/"))
        throw new Error("VIDEO_OUTPUT_INVALID");
      return "https://" + domain + "/" + key;
    };
    return {
      url: assetUrl(output.masterKey),
      expiresAt: new Date(expires * 1000).toISOString(),
      cookies: [],
      public: true,
      assetUrl,
    };
  }
}
