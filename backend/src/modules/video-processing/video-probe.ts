import { spawn } from "node:child_process";
import { VideoError, type SourceMetadata } from "./video-policy";

export async function runProcess(
  executable: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeout?: number;
    onProgress?: (line: string) => void;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      pending = "",
      failed = false;
    const abort = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, options.timeout ?? 60000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onProgress) {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) options.onProgress(line);
      } else {
        output += chunk.toString();
        if (output.length > 2 * 1024 ** 2) abort();
      }
    });
    // Drain stderr but never retain/log it: it can contain signed input URLs.
    child.stderr.resume();
    child.once("error", () => {
      cleanup();
      reject(new VideoError("ENCODER_UNAVAILABLE"));
    });
    child.once("close", (code) => {
      cleanup();
      code === 0 && !failed
        ? resolve(output)
        : reject(
            new VideoError(
              options.signal?.aborted ? "LEASE_LOST" : "ENCODE_FAILED",
            ),
          );
    });
    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  });
}
export function parseProbe(value: unknown): SourceMetadata {
  const data = value as { streams?: any[]; format?: { duration?: string } };
  const videos =
    data.streams?.filter(
      (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
    ) ?? [];
  const v = videos[0];
  if (!v || videos.length !== 1) throw new VideoError("SOURCE_INVALID");
  if (
    v.bits_per_raw_sample > 8 ||
    /10|12|16/.test(v.pix_fmt ?? "") ||
    ["smpte2084", "arib-std-b67"].includes(v.color_transfer)
  )
    throw new VideoError("HDR_UNSUPPORTED");
  const [num, den] = String(v.avg_frame_rate ?? "0/1")
    .split("/")
    .map(Number);
  const [sarN, sarD] = String(v.sample_aspect_ratio ?? "1:1")
    .split(":")
    .map(Number);
  const sar = sarN > 0 && sarD > 0 ? sarN / sarD : 1;
  let width = Number(v.width) * sar,
    height = Number(v.height);
  const rotation = Number(
    v.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ??
      v.tags?.rotate ??
      0,
  );
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const duration = Number(data.format?.duration ?? v.duration),
    fps = num / den;
  if (
    ![width, height, duration, fps].every((n) => Number.isFinite(n) && n > 0) ||
    width > 16384 ||
    height > 16384 ||
    duration > 43200
  )
    throw new VideoError("SOURCE_INVALID");
  const audio = data.streams?.filter((s) => s.codec_type === "audio") ?? [];
  if (audio.length > 1) throw new VideoError("MULTIPLE_AUDIO_UNSUPPORTED");
  return {
    width,
    height,
    duration,
    fps,
    audio: audio.length === 1,
    codec: String(v.codec_name),
    ...(Number.isFinite(v.level) ? { level: v.level } : {}),
    ...(audio[0]?.codec_name
      ? { audioCodec: String(audio[0].codec_name) }
      : {}),
  };
}
export async function probe(path: string, input: string, signal?: AbortSignal) {
  const protocol = input.startsWith("https:") ? "https,tls,tcp" : "file";
  const output = await runProcess(
    path,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      protocol,
      "-probesize",
      "10000000",
      "-analyzeduration",
      "10000000",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      input,
    ],
    { signal, timeout: 60000 },
  );
  try {
    return parseProbe(JSON.parse(output));
  } catch (error) {
    if (error instanceof VideoError) throw error;
    throw new VideoError("SOURCE_INVALID");
  }
}
