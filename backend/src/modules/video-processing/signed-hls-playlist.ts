import { posix } from "node:path";
import { VideoError, objectKey } from "./video-policy";

/** Rewrite every HLS reference so a private CDN never receives an unsigned child request. */
export function rewriteSignedHlsPlaylist(
  playlist: string,
  playlistKey: string,
  prefix: string,
  playlistUrl: (key: string) => string,
  objectUrl: (key: string) => string,
) {
  objectKey(playlistKey);
  objectKey(prefix);
  if (
    !playlistKey.startsWith(prefix + "/") ||
    !playlistKey.endsWith(".m3u8") ||
    !playlist.startsWith("#EXTM3U")
  )
    throw new VideoError("VIDEO_OUTPUT_INVALID");

  const reference = (value: string) => {
    if (
      !value ||
      /[?#\\]/.test(value) ||
      /^[a-z]+:/i.test(value) ||
      value.startsWith("/")
    )
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    const key = posix.normalize(posix.join(posix.dirname(playlistKey), value));
    objectKey(key);
    if (!key.startsWith(prefix + "/"))
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    return key.endsWith(".m3u8") ? playlistUrl(key) : objectUrl(key);
  };

  return playlist
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (!line.startsWith("#")) return reference(line.trim());
      // HLS tags such as EXT-X-MAP, EXT-X-KEY and EXT-X-MEDIA carry URI attributes.
      return line.replace(
        /URI="([^"]+)"/g,
        (_, uri: string) => `URI="${reference(uri)}"`,
      );
    })
    .join("\n");
}
