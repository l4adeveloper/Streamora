export class VideoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface SourceMetadata {
  width: number;
  height: number;
  duration: number;
  fps: number;
  audio: boolean;
  codec: string;
  level?: number;
  audioCodec?: string;
}
export type VideoSource =
  | { kind: "FILE"; storageLocationId: string; key: string }
  | {
      kind: "HLS";
      storageLocationId: string;
      prefix: string;
      masterKey: string;
      channelType: "STANDARD";
      renditionSelection: "ALL";
      expectedHeights: number[];
    };
export interface VideoPolicy {
  outputLocationId?: string;
  version: 1;
  fps: number;
  audio: boolean;
  duration: number;
  renditions: { id: string; width: number; height: number; bitrate: number }[];
}
export interface VideoOutput {
  storageLocationId: string;
  prefix: string;
  masterKey: string;
  duration: number;
  renditions: {
    id: string;
    width: number;
    height: number;
    bitrate: number;
    variantKey: string;
    codecs: string;
  }[];
  thumbnailKey?: string;
}
export function objectKey(key: unknown): asserts key is string {
  if (
    typeof key !== "string" ||
    key.length > 1024 ||
    !/^[A-Za-z0-9_./-]+$/.test(key) ||
    key
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
      )
  )
    throw new VideoError("VIDEO_OUTPUT_INVALID");
}
export function readSource(value: unknown): VideoSource {
  const s = value as VideoSource;
  if (!s || !/^[a-f0-9]{64}$/.test(s.storageLocationId))
    throw new VideoError("SOURCE_MISSING");
  if (s.kind === "FILE") objectKey(s.key);
  else if (s.kind === "HLS") {
    objectKey(s.prefix);
    objectKey(s.masterKey);
    if (!s.masterKey.startsWith(s.prefix + "/"))
      throw new VideoError("SOURCE_MISSING");
    if (s.channelType !== "STANDARD")
      throw new VideoError("CHANNEL_NOT_STANDARD");
    if (
      s.renditionSelection !== "ALL" ||
      !Array.isArray(s.expectedHeights) ||
      !s.expectedHeights.length ||
      s.expectedHeights.some((h) => !Number.isInteger(h) || h <= 0)
    )
      throw new VideoError("RENDITION_MISSING");
  } else throw new VideoError("SOURCE_MISSING");
  return s;
}
const profiles = [
  [2160, 22000000],
  [1440, 12000000],
  [1080, 6000000],
  [720, 3000000],
  [480, 1400000],
  [360, 800000],
];
export function qualityLabel(width: number, height: number) {
  const short = Math.min(width, height),
    long = Math.max(width, height);
  return short >= 2160 && long >= 3840 ? "2160p (4K)" : `${short}p`;
}
export function makePolicy(
  source: SourceMetadata,
  cap = 2160,
  optional: number[] = [480, 1440],
): VideoPolicy {
  const { width, height } = source;
  if (
    ![width, height, source.duration, source.fps].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    throw new VideoError("SOURCE_INVALID");
  const short = Math.min(width, height);
  // Keep the encoded frame within the supported 4K bounding box, including ultrawide sources.
  const maximum = Math.min(
    short,
    cap,
    (3840 * short) / Math.max(width, height),
  );
  const rendition = (shortEdge: number, bitrate: number) => {
    const scale = Math.min(shortEdge / short, 1);
    const outputW = Math.max(2, Math.floor((width * scale) / 2) * 2),
      outputH = Math.max(2, Math.floor((source.height * scale) / 2) * 2);
    return {
      id: `${Math.min(outputW, outputH)}p`,
      width: outputW,
      height: outputH,
      bitrate,
    };
  };
  const renditions = profiles
    .filter(
      ([h]) =>
        h <= maximum && (![480, 1440].includes(h) || optional.includes(h)),
    )
    .map(([h, bitrate]) => rendition(h, bitrate))
    .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
  // Preserve the highest source resolution too (for example 900p), within the cap.
  const highest = maximum;
  const bitrate = profiles.find(([h]) => h <= highest)?.[1] ?? 600000;
  const top = rendition(highest, bitrate);
  if (!renditions.some((r) => r.id === top.id)) renditions.unshift(top);
  return {
    version: 1,
    fps: Math.min(30, source.fps),
    audio: source.audio,
    duration: source.duration,
    renditions,
  };
}
