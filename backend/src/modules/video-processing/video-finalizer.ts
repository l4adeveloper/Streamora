import { posix } from "node:path";
import { VideoStorage } from "./video-storage";
import {
  objectKey,
  VideoError,
  type VideoOutput,
  type VideoPolicy,
  type SourceMetadata,
} from "./video-policy";

export function reference(from: string, uri: string, prefix: string) {
  // No remote URI, query token, encoded traversal, absolute path, or escape from the asset tree.
  if (!uri || /[:?%#\\\x00-\x20]/.test(uri) || uri.startsWith("/"))
    throw new VideoError("VIDEO_OUTPUT_INVALID");
  const key = posix.normalize(posix.join(posix.dirname(from), uri));
  objectKey(key);
  if (!key.startsWith(prefix + "/"))
    throw new VideoError("VIDEO_OUTPUT_INVALID");
  return key;
}
function attributes(line: string) {
  const result: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))
    result[m[1]] = m[2].replace(/^"|"$/g, "");
  return result;
}
export async function verifyHls(
  storage: VideoStorage,
  location: string,
  prefix: string,
  masterKey: string,
  policy?: VideoPolicy,
  expectedHeights?: number[],
  inspect?: (key: string) => Promise<SourceMetadata>,
): Promise<VideoOutput> {
  objectKey(prefix);
  objectKey(masterKey);
  if (!masterKey.startsWith(prefix + "/"))
    throw new VideoError("VIDEO_OUTPUT_INVALID");
  const target = await storage.locations.resolve(location);
  const listed =
    target.driver === "s3" ? await storage.list(location, prefix) : undefined;
  const master = await storage.text(location, masterKey);
  if (!master.startsWith("#EXTM3U"))
    throw new VideoError("VIDEO_OUTPUT_INVALID");
  const renditions: VideoOutput["renditions"] = [];
  const auxiliary: string[] = [];
  const lines = master.trim().split(/\r?\n/);
  let info: Record<string, string> | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) info = attributes(line);
    else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = attributes(line);
      if (attrs.URI) auxiliary.push(reference(masterKey, attrs.URI, prefix));
    } else if (
      line.startsWith("#EXT-X-SESSION-KEY") ||
      line.startsWith("#EXT-X-SESSION-DATA")
    )
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    else if (line.startsWith("#") && /URI=/.test(line))
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    else if (line && !line.startsWith("#")) {
      if (!info) throw new VideoError("VIDEO_OUTPUT_INVALID");
      const [width, height] = (info.RESOLUTION ?? "").split("x").map(Number),
        bitrate = Number(info.BANDWIDTH);
      if (
        ![width, height, bitrate].every((n) => Number.isFinite(n) && n > 0) ||
        !info.CODECS ||
        renditions.length >= 16
      )
        throw new VideoError("VIDEO_OUTPUT_INVALID");
      const variantKey = reference(masterKey, line, prefix);
      renditions.push({
        id: `${Math.min(width, height)}p-${renditions.length}`,
        width,
        height,
        bitrate,
        variantKey,
        codecs: info.CODECS,
      });
      info = undefined;
    }
  }
  if (!renditions.length || info) throw new VideoError("RENDITION_MISSING");
  let duration = 0;
  const timelines: number[][] = [];
  for (const key of [...renditions.map((r) => r.variantKey), ...auxiliary]) {
    const playlist = await storage.text(location, key);
    if (!playlist.startsWith("#EXTM3U") || !playlist.includes("#EXT-X-ENDLIST"))
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    let segments = 0,
      time = 0,
      segmentDuration = 0;
    const boundaries: number[] = [];
    let firstSegment: string | undefined;
    for (const raw of playlist.trim().split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("#EXTINF:")) {
        segmentDuration = Number(line.slice(8).split(",")[0]);
        if (!(segmentDuration > 0) || !Number.isFinite(segmentDuration))
          throw new VideoError("VIDEO_OUTPUT_INVALID");
      }
      if (line.startsWith("#EXT-X-KEY") || line.startsWith("#EXT-X-BYTERANGE"))
        throw new VideoError("VIDEO_OUTPUT_INVALID");
      const uri = line.startsWith("#")
        ? /URI="([^"]+)"/.exec(line)?.[1]
        : line || undefined;
      if (!uri) continue;
      const child = reference(key, uri, prefix);
      if (!(await storage.exists(location, child, listed)))
        throw new VideoError("RENDITION_MISSING");
      if (!line.startsWith("#")) {
        firstSegment ??= child;
        if (!segmentDuration) throw new VideoError("VIDEO_OUTPUT_INVALID");
        segments++;
        time += segmentDuration;
        boundaries.push(time);
        segmentDuration = 0;
      }
    }
    if (!segments) throw new VideoError("RENDITION_MISSING");
    const rendition = renditions.find((r) => r.variantKey === key);
    if (inspect && rendition && firstSegment) {
      const actual = await inspect(firstSegment);
      const avc = /avc1\.[a-f0-9]{4}([a-f0-9]{2})/i.exec(rendition.codecs);
      if (
        actual.width !== rendition.width ||
        actual.height !== rendition.height ||
        actual.codec !== "h264" ||
        !avc ||
        (actual.level !== undefined && actual.level !== parseInt(avc[1], 16)) ||
        (policy &&
          (actual.audio !== policy.audio ||
            (actual.audio && actual.audioCodec !== "aac")))
      )
        throw new VideoError("VIDEO_METADATA_INVALID");
    }
    timelines.push(boundaries);
    duration = Math.max(duration, time);
  }
  const baseline = timelines[0];
  if (
    timelines.some(
      (t) =>
        t.length !== baseline.length ||
        t.some((n, i) => Math.abs(n - baseline[i]) > 0.25),
    )
  )
    throw new VideoError("VIDEO_TIMELINE_INVALID");
  if (
    policy &&
    (policy.renditions.length !== renditions.length ||
      policy.renditions.some(
        (r) =>
          !renditions.some((o) => o.width === r.width && o.height === r.height),
      ) ||
      Math.abs(duration - policy.duration) > 1)
  )
    throw new VideoError("RENDITION_MISSING");
  if (expectedHeights?.some((h) => !renditions.some((r) => r.height === h)))
    throw new VideoError("RENDITION_MISSING");
  const thumbnailKey = `${prefix}/thumbnails/poster.jpg`;
  const thumbnail = listed
    ? [...listed].find(
        (k) =>
          (k.startsWith(`${prefix}/thumbnails/`) ||
            k.startsWith(`${prefix}/media/thumbnails/`) ||
            k === `${prefix}/media/latest_thumbnail/thumb.jpg`) &&
          /\.jpe?g$/.test(k),
      )
    : (await storage.exists(location, thumbnailKey))
      ? thumbnailKey
      : undefined;
  return {
    storageLocationId: location,
    prefix,
    masterKey,
    duration,
    renditions,
    ...(thumbnail ? { thumbnailKey: thumbnail } : {}),
  };
}
