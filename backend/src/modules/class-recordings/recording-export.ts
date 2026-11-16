import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FileStorageService } from "../files/file-storage.service";
import { objectKey } from "../video-processing/video-policy";
import { runProcess } from "../video-processing/video-probe";

/** Resolve only relative IVS objects inside this recording's trusted S3 prefix. */
export function recordingKey(prefix: string, base: string, uri: string) {
  if (!uri || uri.startsWith("/") || /[:?#%\\\x00-\x20]/.test(uri))
    throw new Error("RECORDING_PATH_INVALID");
  const key = posix.normalize(posix.join(posix.dirname(base), uri));
  objectKey(key);
  if (!key.startsWith(prefix + "/")) throw new Error("RECORDING_PATH_INVALID");
  return key;
}

export async function recordingText(
  storage: FileStorageService,
  location: string,
  key: string,
) {
  const stream = await storage.read(key, location);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 2 * 1024 ** 2) throw new Error("RECORDING_METADATA_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    stream.destroy();
  }
}

/** Remux finished HLS into MP4 without re-encoding. Original HLS stays on S3. */
export async function exportRecording(
  storage: FileStorageService,
  location: string,
  prefix: string,
  masterKey: string,
  directory: string,
  ffmpeg: string,
  signal: AbortSignal,
  onStep?: (
    step: "read_hls_playlist" | "download_hls" | "remux_mp4" | "upload_mp4",
  ) => void,
) {
  const localPath = (key: string) =>
    join(directory, key.slice(prefix.length + 1));
  let playlistKey = masterKey;
  onStep?.("read_hls_playlist");
  let playlist = await recordingText(storage, location, playlistKey);
  if (!playlist.startsWith("#EXTM3U"))
    throw new Error("RECORDING_PLAYLIST_INVALID");
  // One configured IVS encoder; select a video variant from the master playlist.
  if (playlist.includes("#EXT-X-STREAM-INF:")) {
    const lines = playlist.split(/\r?\n/).map((line) => line.trim());
    const index = lines.findIndex((line) =>
      line.startsWith("#EXT-X-STREAM-INF:"),
    );
    playlistKey = recordingKey(prefix, playlistKey, lines[index + 1] ?? "");
    playlist = await recordingText(storage, location, playlistKey);
  }
  if (
    !playlist.startsWith("#EXTM3U") ||
    !playlist.includes("#EXT-X-ENDLIST") ||
    playlist.includes("#EXT-X-KEY:")
  )
    throw new Error("RECORDING_NOT_FINALIZED");
  const keys = new Set<string>();
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith("#"))
      keys.add(recordingKey(prefix, playlistKey, line));
    for (const match of line.matchAll(/URI="([^"]+)"/g))
      keys.add(recordingKey(prefix, playlistKey, match[1]));
  }
  if (!keys.size || keys.size > 20000)
    throw new Error("RECORDING_PLAYLIST_INVALID");
  let bytes = 0;
  const queue = [...keys];
  const downloads = new AbortController();
  const downloadSignal = AbortSignal.any([signal, downloads.signal]);
  onStep?.("download_hls");
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, async () => {
      try {
        for (;;) {
          const key = queue.shift();
          if (!key) return;
          downloadSignal.throwIfAborted();
          const path = localPath(key);
          await mkdir(join(path, ".."), { recursive: true });
          const stream = await storage.read(key, location, downloadSignal);
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4 * 1024 ** 3)
              stream.destroy(new Error("RECORDING_EXPORT_TOO_LARGE"));
          });
          await pipeline(stream, createWriteStream(path), {
            signal: downloadSignal,
          });
        }
      } catch (error) {
        downloads.abort(error);
        throw error;
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const input = localPath(playlistKey);
  await mkdir(join(input, ".."), { recursive: true });
  await writeFile(input, playlist);
  const output = join(directory, "recording.mp4");
  onStep?.("remux_mp4");
  await runProcess(
    ffmpeg,
    [
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-allowed_extensions",
      "ALL",
      "-i",
      basename(input),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-y",
      output,
    ],
    { signal, timeout: 30 * 60_000, cwd: dirname(input) },
  );
  const info = await stat(output);
  if (!info.size) throw new Error("RECORDING_EMPTY");
  const key = prefix + "/recording.mp4";
  onStep?.("upload_mp4");
  await storage.writeFile(output, key, "video/mp4", location);
  return { key, size: info.size };
}
