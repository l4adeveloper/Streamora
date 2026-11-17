import { reference } from "./video-finalizer";
import { objectKey, VideoError, type VideoOutput } from "./video-policy";

export interface ReplicationPlan {
  objects: string[];
  // Child playlists first, master last; publication never precedes media data.
  playlists: { key: string; text: string }[];
}
export async function planVodReplication(
  output: VideoOutput,
  read: (key: string) => Promise<string>,
): Promise<ReplicationPlan> {
  objectKey(output.prefix);
  objectKey(output.masterKey);
  if (!output.masterKey.startsWith(output.prefix + "/"))
    throw new VideoError("VIDEO_OUTPUT_INVALID");
  const objects = new Set<string>(),
    visited = new Set<string>(),
    visiting = new Set<string>();
  const playlists: ReplicationPlan["playlists"] = [];
  const walk = async (key: string) => {
    if (visiting.has(key)) throw new VideoError("VIDEO_OUTPUT_INVALID");
    if (visited.has(key)) return;
    if (visited.size + visiting.size >= 64)
      throw new VideoError("REPLICA_LIMIT_EXCEEDED");
    visiting.add(key);
    const text = await read(key);
    if (!text.startsWith("#EXTM3U") || Buffer.byteLength(text) > 2 * 1024 ** 2)
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    const children: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const uris = line.startsWith("#")
        ? [...line.matchAll(/(?:^|[, :])URI="([^"]+)"/g)].map(
            (match) => match[1],
          )
        : [line];
      if (line.startsWith("#") && /URI=/.test(line) && !uris.length)
        throw new VideoError("VIDEO_OUTPUT_INVALID");
      for (const uri of uris) {
        const child = reference(key, uri, output.prefix);
        if (child.endsWith(".m3u8")) children.push(child);
        else objects.add(child);
        if (objects.size > 200000)
          throw new VideoError("REPLICA_LIMIT_EXCEEDED");
      }
    }
    if (!children.length && !text.includes("#EXT-X-ENDLIST"))
      throw new VideoError("SOURCE_NOT_READY");
    for (const child of children) await walk(child);
    visiting.delete(key);
    visited.add(key);
    playlists.push({ key, text });
  };
  await walk(output.masterKey);
  for (const rendition of output.renditions)
    if (!visited.has(rendition.variantKey))
      throw new VideoError("RENDITION_MISSING");
  if (output.thumbnailKey) {
    objectKey(output.thumbnailKey);
    if (!output.thumbnailKey.startsWith(output.prefix + "/"))
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    objects.add(output.thumbnailKey);
  }
  if (!objects.size) throw new VideoError("SOURCE_NOT_READY");
  return { objects: [...objects], playlists };
}
