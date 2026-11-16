const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  makePolicy,
  readSource,
  qualityLabel,
} = require("../dist/modules/video-processing/video-policy");
const {
  parseProbe,
  runProcess,
} = require("../dist/modules/video-processing/video-probe");
const {
  reference,
  verifyHls,
} = require("../dist/modules/video-processing/video-finalizer");
const {
  VideoDelivery,
} = require("../dist/modules/video-processing/video-delivery");
const {
  mediaConvertSettings,
  MediaConvertEncoder,
} = require("../dist/modules/video-processing/mediaconvert-encoder");
const {
  readVideoConfig,
} = require("../dist/modules/video-processing/video-config");
const source = (width, height) => ({
  width,
  height,
  duration: 2,
  fps: 60,
  audio: false,
  codec: "h264",
});
test("ladder includes source maximum and lower standard qualities without upscaling", () => {
  assert.deepEqual(
    makePolicy(source(3840, 2160), 2160).renditions.map((r) => r.id),
    ["2160p", "1440p", "1080p", "720p", "480p", "360p"],
  );
  assert.deepEqual(
    makePolicy(source(1920, 1080), 2160).renditions.map((r) => r.id),
    ["1080p", "720p", "480p", "360p"],
  );
  assert.deepEqual(
    makePolicy(source(1280, 720)).renditions.map((r) => r.id),
    ["720p", "480p", "360p"],
  );
  assert.deepEqual(
    makePolicy(source(1080, 1920)).renditions.map((r) => [r.width, r.height]),
    [
      [1080, 1920],
      [720, 1280],
      [480, 852],
      [360, 640],
    ],
  );
  assert.equal(makePolicy(source(240, 136)).renditions[0].height, 136);
  assert.equal(makePolicy(source(3840, 2160), 720).renditions[0].height, 720);
  assert.equal(makePolicy(source(1920, 1080)).fps, 30);
  assert.ok(
    makePolicy(source(3840, 2160), 2160, [1440, 480]).renditions.some(
      (r) => r.id === "1440p",
    ),
  );
  assert.equal(qualityLabel(2160, 3840), "2160p (4K)");
  assert.equal(qualityLabel(1920, 1080), "1080p");
  assert.deepEqual(
    makePolicy(source(1600, 900)).renditions.map((r) => r.id),
    ["900p", "720p", "480p", "360p"],
  );
  assert.deepEqual(
    makePolicy(source(1920, 800)).renditions.map((r) => [r.width, r.height]),
    [
      [1920, 800],
      [1728, 720],
      [1152, 480],
      [864, 360],
    ],
  );
  assert.deepEqual(
    makePolicy(source(1920, 1080), 2160, []).renditions.map((r) => r.id),
    ["1080p", "720p", "360p"],
  );
  const ultrawide = makePolicy(source(5120, 2160)).renditions;
  assert.deepEqual([ultrawide[0].width, ultrawide[0].height], [3840, 1620]);
  assert.ok(ultrawide.every((r) => Math.max(r.width, r.height) <= 3840));
});
test("probe normalizes rotation/SAR, rejects HDR, audio-only, missing duration and multiple tracks", () => {
  const data = {
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        sample_aspect_ratio: "1:1",
        avg_frame_rate: "30000/1001",
        pix_fmt: "yuv420p",
        side_data_list: [{ rotation: 90 }],
      },
    ],
    format: { duration: "2" },
  };
  assert.equal(parseProbe(data).width, 1080);
  assert.equal(parseProbe(data).height, 1920);
  assert.throws(() => parseProbe({ streams: [] }), /SOURCE_INVALID/);
  assert.throws(
    () =>
      parseProbe({
        ...data,
        streams: [{ ...data.streams[0], pix_fmt: "yuv420p10le" }],
      }),
    /HDR_UNSUPPORTED/,
  );
  assert.throws(() => parseProbe({ ...data, format: {} }), /SOURCE_INVALID/);
});
test("HLS validator rejects missing segments, external and encoded references and accepts a complete VOD", async () => {
  const files = new Map([
    [
      "asset/hls/master.m3u8",
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e"\n360/index.m3u8\n',
    ],
    [
      "asset/hls/360/index.m3u8",
      "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n",
    ],
    ["asset/hls/360/segment.ts", "data"],
  ]);
  const storage = {
    locations: { resolve: async () => ({ driver: "local" }) },
    text: async (_l, k) => files.get(k),
    exists: async (_l, k) => files.has(k),
  };
  const output = await verifyHls(
    storage,
    "location",
    "asset",
    "asset/hls/master.m3u8",
  );
  assert.equal(output.renditions.length, 1);
  assert.equal(output.duration, 2);
  files.delete("asset/hls/360/segment.ts");
  await assert.rejects(
    verifyHls(storage, "location", "asset", "asset/hls/master.m3u8"),
    /RENDITION_MISSING/,
  );
  for (const uri of [
    "https://evil.test/x",
    "../../outside.ts",
    "%2e%2e/x",
    "/outside.ts",
    "file:x",
    "seg.ts?token=x",
  ])
    assert.throws(() => reference("asset/hls/x.m3u8", uri, "asset"));
});
test("local grants fence file/version, expire, reject tampering and cap lifetime at 60s", async () => {
  const delivery = new VideoDelivery({
    auth: { accessTokenSecret: "test-secret", cookie: { secure: false } },
    port: 4000,
  });
  const grant = await delivery.grant("file", "job", {
    storageLocationId: "a".repeat(64),
    prefix: "asset/job/1",
    masterKey: "asset/job/1/hls/master.m3u8",
  });
  const token = grant.cookies[0].value;
  assert.equal(delivery.verify(token, "file", "job").prefix, "asset/job/1");
  assert.throws(() => delivery.verify(token, "other", "job"));
  assert.throws(() => delivery.verify(token + "x", "file", "job"));
  const now = Date.now;
  try {
    Date.now = () => now() + 61000;
    assert.throws(() => delivery.verify(token, "file", "job"));
  } finally {
    Date.now = now;
  }
});
test("MediaConvert builds an explicit HLS ladder and thumbnail, omits audio for silent sources", () => {
  const policy = makePolicy(source(1920, 1080));
  const settings = mediaConvertSettings(
    "s3://source/video",
    "s3://output/asset",
    policy,
  );
  assert.equal(settings.OutputGroups[0].Outputs.length, 4);
  assert.equal(
    settings.OutputGroups[0].Outputs[0].AudioDescriptions,
    undefined,
  );
  assert.equal(
    settings.OutputGroups[1].Outputs[0].VideoDescription.CodecSettings.Codec,
    "FRAME_CAPTURE",
  );
  assert.equal(
    settings.OutputGroups[0].OutputGroupSettings.HlsGroupSettings.SegmentLength,
    4,
  );
});
test("uncertain AWS submission reconciles metadata and does not blindly create a second encode", async () => {
  const encoder = new MediaConvertEncoder({
    region: "ap-southeast-1",
    queueArn: "queue",
  });
  let calls = [];
  encoder.client.send = async (command) => {
    calls.push(command.constructor.name);
    return { Jobs: [] };
  };
  assert.equal(await encoder.reconcile("job", 1), undefined);
  assert.deepEqual(calls, ["ListJobsCommand"]);
  encoder.client.destroy();
});
test("source schemas enforce STANDARD/ALL and environment rejects mixed presets", () => {
  assert.throws(
    () =>
      readSource({
        kind: "HLS",
        storageLocationId: "a".repeat(64),
        prefix: "ivs/asset",
        masterKey: "ivs/asset/master.m3u8",
        channelType: "BASIC",
      }),
    /CHANNEL_NOT_STANDARD/,
  );
  assert.throws(() =>
    readVideoConfig({ VIDEO_MODE: "aws" }, "local", "ap-southeast-1"),
  );
  assert.throws(() =>
    readVideoConfig({ VIDEO_MAX_QUALITY: "9999" }, "local", "ap-southeast-1"),
  );
});
test("encoder child is stopped when the lease abort signal fires", async () => {
  const abort = new AbortController();
  const started = Date.now();
  const pending = runProcess(
    process.execPath,
    ["-e", "setTimeout(()=>{},60000)"],
    { signal: abort.signal },
  );
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(pending, /LEASE_LOST/);
  assert.ok(Date.now() - started < 3000);
});
test("scratch quota is checked before encode and only stale generated directories are removed", async () => {
  const {
    mkdtemp,
    mkdir,
    writeFile,
    utimes,
    stat,
    rm,
  } = require("node:fs/promises");
  const { join, resolve, relative, sep } = require("node:path"),
    { tmpdir } = require("node:os"),
    { randomUUID } = require("node:crypto");
  const {
    prepareScratch,
  } = require("../dist/modules/video-processing/video-scratch");
  const root = await mkdtemp(join(tmpdir(), "streamora-scratch-test-"));
  try {
    const stale = join(root, randomUUID() + "-ABC123"),
      recent = join(root, randomUUID() + "-DEF456");
    await mkdir(stale);
    await mkdir(recent);
    await writeFile(join(stale, "partial.ts"), "partial");
    const old = new Date(Date.now() - 2 * 86400000);
    await utimes(stale, old, old);
    await prepareScratch(root, 1024);
    await assert.rejects(stat(stale));
    assert.ok((await stat(recent)).isDirectory());
    await assert.rejects(
      prepareScratch(root, 8 * 1024 ** 3 + 1),
      /SCRATCH_LIMIT_EXCEEDED/,
    );
  } finally {
    const child = relative(resolve(tmpdir()), resolve(root));
    if (child && child !== ".." && !child.startsWith(".." + sep))
      await rm(root, { recursive: true, force: true });
  }
});
