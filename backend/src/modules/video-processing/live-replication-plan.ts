import { reference } from "./video-finalizer";
import { objectKey, VideoError } from "./video-policy";

export interface LiveSnapshot {
  prefix: string;
  masterKey: string;
  playlists: Record<string, string>;
  objects: string[];
  readyThroughSeconds: number;
  ended: boolean;
}

// DVR requires the complete timeline from sequence zero. A sliding live window
// cannot be represented as seconds from the recording start without a time map.
export async function planLiveReplication(
  prefix: string,
  masterKey: string,
  read: (key: string) => Promise<string>,
): Promise<LiveSnapshot> {
  objectKey(prefix);
  objectKey(masterKey);
  if (!masterKey.startsWith(prefix + "/"))
    throw new VideoError("VIDEO_OUTPUT_INVALID");
  const playlists: Record<string, string> = {};
  const objects = new Set<string>(),
    visiting = new Set<string>();
  const durations: number[] = [],
    endings: boolean[] = [];
  let totalBytes = 0;
  const walk = async (key: string): Promise<void> => {
    if (visiting.has(key)) throw new VideoError("VIDEO_OUTPUT_INVALID");
    if (Object.hasOwn(playlists, key)) return;
    if (Object.keys(playlists).length + visiting.size >= 64)
      throw new VideoError("REPLICA_LIMIT_EXCEEDED");
    visiting.add(key);
    const text = await read(key);
    totalBytes += Buffer.byteLength(text);
    if (
      !text.startsWith("#EXTM3U") ||
      totalBytes > 8 * 1024 ** 2 ||
      /#EXT-X-(?:KEY|SESSION-KEY|PART|PRELOAD-HINT|BYTERANGE|GAP)[:\r\n]/.test(
        text,
      )
    )
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    const children = new Set<string>();
    let duration = 0,
      pending: number | undefined,
      segments = 0;
    const sequence = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/m);
    if (sequence && Number(sequence[1]) !== 0)
      throw new VideoError("DVR_WINDOW_UNSUPPORTED");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXTINF:")) {
        pending = Number(line.slice(8).split(",")[0]);
        if (!Number.isFinite(pending) || pending <= 0)
          throw new VideoError("VIDEO_OUTPUT_INVALID");
      }
      const uris = line.startsWith("#")
        ? [...line.matchAll(/(?:^|[, :])URI="([^"]+)"/g)].map((m) => m[1])
        : [line];
      if (line.startsWith("#") && /URI=/.test(line) && !uris.length)
        throw new VideoError("VIDEO_OUTPUT_INVALID");
      for (const uri of uris) {
        const child = reference(key, uri, prefix);
        if (child.endsWith(".m3u8")) children.add(child);
        else {
          objects.add(child);
          if (!line.startsWith("#")) {
            if (pending === undefined)
              throw new VideoError("VIDEO_OUTPUT_INVALID");
            duration += pending;
            pending = undefined;
            segments++;
          }
        }
      }
      if (objects.size > 200000) throw new VideoError("REPLICA_LIMIT_EXCEEDED");
    }
    if (pending !== undefined) throw new VideoError("SOURCE_NOT_READY");
    if (!children.size) {
      if (!segments) throw new VideoError("SOURCE_NOT_READY");
      durations.push(duration);
      endings.push(text.includes("#EXT-X-ENDLIST"));
    }
    for (const child of children) await walk(child);
    visiting.delete(key);
    playlists[key] = text;
  };
  await walk(masterKey);
  if (!durations.length) throw new VideoError("SOURCE_NOT_READY");
  return {
    prefix,
    masterKey,
    playlists,
    objects: [...objects],
    readyThroughSeconds: Math.min(...durations),
    ended: endings.every(Boolean),
  };
}
