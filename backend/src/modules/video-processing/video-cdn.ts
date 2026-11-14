import type { StorageTarget } from "../files/storage-locations.service";
import type { VideoOutput } from "./video-policy";

export const VIDEO_CDN_PROVIDERS = Symbol("VIDEO_CDN_PROVIDERS");

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
  assetUrl(key: string): string;
}

export interface VideoCdnProvider {
  supports(target: StorageTarget): boolean;
  grant(
    fileId: string,
    output: VideoOutput,
    expires: number,
  ): Promise<MediaGrant>;
}
