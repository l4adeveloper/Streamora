import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./video-probe";
import type { VideoPolicy } from "./video-policy";
function h264Level(width: number, height: number, fps: number) {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  return [
    [3, 1620, 40500, 30],
    [3.1, 3600, 108000, 31],
    [4, 8192, 245760, 40],
    [5, 22080, 589824, 50],
    [5.1, 36864, 983040, 51],
  ].find(([, size, rate]) => blocks <= size && blocks * fps <= rate)!;
}

export async function encodeFfmpeg(
  executable: string,
  input: string,
  directory: string,
  policy: VideoPolicy,
  signal: AbortSignal,
  progress: (percent: number) => void,
) {
  const args = [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-threads",
    "2",
    "-i",
    input,
    "-filter_complex_threads",
    "1",
  ];
  for (const r of policy.renditions) {
    const [level] = h264Level(r.width, r.height, policy.fps);
    await mkdir(join(directory, "hls", r.id), { recursive: true });
    args.push("-map", "0:v:0");
    if (policy.audio) args.push("-map", "0:a:0");
    args.push(
      "-vf",
      `scale=${r.width}:${r.height},setsar=1,fps=${policy.fps}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      "-preset",
      "veryfast",
      "-profile:v",
      "high",
      "-level:v",
      String(level),
      "-b:v",
      String(r.bitrate),
      "-maxrate",
      String(r.bitrate),
      "-bufsize",
      String(r.bitrate * 2),
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*4)",
      "-g",
      String(Math.ceil(policy.fps * 4)),
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-f",
      "hls",
      "-hls_time",
      "4",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      join(directory, "hls", r.id, "segment-%05d.ts"),
      join(directory, "hls", r.id, "index.m3u8"),
    );
  }
  args.push("-progress", "pipe:1", "-nostats");
  await runProcess(executable, args, {
    signal,
    timeout: 4 * 3600000,
    onProgress: (line) => {
      const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
      if (match)
        progress(
          Math.min(
            99,
            Math.floor((Number(match[1]) / 1000000 / policy.duration) * 100),
          ),
        );
    },
  });
  // Publish master after every variant and segment has finished.
  const variants: string[] = [];
  for (const r of policy.renditions) {
    const playlist = await readFile(
      join(directory, "hls", r.id, "index.m3u8"),
      "utf8",
    );
    let duration = 0,
      peak = 0;
    for (const line of playlist.split(/\r?\n/)) {
      if (line.startsWith("#EXTINF:"))
        duration = Number(line.slice(8).split(",")[0]);
      else if (line && !line.startsWith("#") && duration > 0) {
        peak = Math.max(
          peak,
          ((await stat(join(directory, "hls", r.id, line))).size * 8) /
            duration,
        );
        duration = 0;
      }
    }
    const level = h264Level(r.width, r.height, policy.fps)[3]
      .toString(16)
      .padStart(2, "0");
    variants.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(peak * 1.05)},RESOLUTION=${r.width}x${r.height},FRAME-RATE=${policy.fps.toFixed(3)},CODECS="avc1.6400${level}${policy.audio ? ",mp4a.40.2" : ""}"\n${r.id}/index.m3u8\n`,
    );
  }
  await writeFile(
    join(directory, "hls", "master.m3u8"),
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n" +
      variants.join(""),
  );
  await mkdir(join(directory, "thumbnails"), { recursive: true });
  try {
    await runProcess(
      executable,
      [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-threads",
        "1",
        "-i",
        input,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-threads",
        "1",
        join(directory, "thumbnails", "poster.jpg"),
      ],
      { signal, timeout: 60000 },
    );
  } catch {
    /* Thumbnail is optional for playback. */
  }
}
