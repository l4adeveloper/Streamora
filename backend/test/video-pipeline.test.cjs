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
test("ladder is bounded by source and cap, portrait labels use short edge, optional profiles are explicit", () => {
  assert.deepEqual(
    makePolicy(source(3840, 2160), 2160).renditions.map((r) => r.id),
    ["2160p", "1080p", "720p", "360p"],
  );
  assert.deepEqual(
    makePolicy(source(1920, 1080), 2160).renditions.map((r) => r.id),
    ["1080p", "720p", "360p"],
  );
  assert.deepEqual(
    makePolicy(source(1280, 720)).renditions.map((r) => r.id),
    ["720p", "360p"],
  );
  assert.deepEqual(
    makePolicy(source(1080, 1920)).renditions.map((r) => [r.width, r.height]),
    [
      [1080, 1920],
      [720, 1280],
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
  assert.equal(settings.OutputGroups[0].Outputs.length, 3);
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
test("dispatch handles terminal jobs idempotently and propagates database failures", async () => {
  const {
    VideoWorker,
  } = require("../dist/modules/video-processing/video-worker");
  for (const state of ["READY", "FAILED", "PROCESSING"]) {
    const row = {
      id: "job",
      fileId: "file",
      state,
      file: { objectKey: "source", recordingId: "recording" },
    };
    const worker = new VideoWorker(
      {
        config: { video: { mode: "aws" } },
        db: { videoJob: { findUnique: async () => row } },
      },
      {},
    );
    worker.sqs = {};
    worker.encoder = {};
    worker.once = async () => {
      throw new Error("db unavailable");
    };
    const work = worker.handleMessage(
      JSON.stringify({
        jobId: "job",
        recordingId: "recording",
        sourceObjectKey: "source",
        outputVersion: "job",
      }),
      false,
    );
    if (state === "PROCESSING") await assert.rejects(work, /db unavailable/);
    else await work;
  }
});

test("early completion resolves provider mapping; stale attempts do no work and foreign accounts are rejected", async () => {
  const {
    VideoWorker,
  } = require("../dist/modules/video-processing/video-worker");
  const row = {
    id: "job",
    attemptNo: 1,
    state: "SUBMITTING",
    providerJobId: null,
  };
  let calls = [];
  const service = {
    config: {
      video: {
        mode: "aws",
        accountId: "123456789012",
        region: "ap-southeast-1",
      },
    },
    db: {
      videoJob: {
        findUnique: async () => row,
        updateMany: async ({ data }) => {
          Object.assign(row, data);
          return { count: 1 };
        },
      },
    },
  };
  const worker = new VideoWorker(service, {}, {});
  worker.sqs = {
    send: async (command) => {
      calls.push(command.constructor.name);
    },
  };
  worker.encoder = {
    inspect: async () => ({
      UserMetadata: { project: "streamora", jobId: "job", attemptNo: "1" },
    }),
  };
  worker.once = async () => {
    row.state = "READY";
    return true;
  };
  const event = {
    source: "aws.mediaconvert",
    account: "123456789012",
    region: "ap-southeast-1",
    "detail-type": "MediaConvert Job State Change",
    detail: {
      jobId: "provider",
      status: "COMPLETE",
      userMetadata: { project: "streamora", jobId: "job", attemptNo: "1" },
    },
  };
  await worker.handleMessage(JSON.stringify(event), true);
  assert.equal(row.providerJobId, "provider");
  assert.deepEqual(calls, []);
  calls = [];
  await assert.rejects(
    worker.handleMessage(
      JSON.stringify({ ...event, account: "999999999999" }),
      true,
    ),
    /PROVIDER_MISMATCH/,
  );
  await assert.doesNotReject(
    worker.handleMessage(
      JSON.stringify({
        ...event,
        detail: {
          ...event.detail,
          userMetadata: { ...event.detail.userMetadata, attemptNo: "2" },
        },
      }),
      true,
    ),
  );
  assert.deepEqual(calls, []);
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
test("standalone video worker context initializes without chat or WebSocket gateways", async () => {
  const { Module } = require("@nestjs/common");
  const { NestFactory } = require("@nestjs/core");
  const {
    ConfigurationModule,
  } = require("../dist/config/configuration.module");
  const { PrismaService } = require("../dist/database/prisma.service");
  const {
    VideoProcessingCoreModule,
  } = require("../dist/modules/video-processing/video-processing-core.module");
  const {
    VideoWorker,
  } = require("../dist/modules/video-processing/video-worker");
  const {
    MembershipGateway,
  } = require("../dist/modules/memberships/membership.gateway");
  const { ChatStore } = require("../dist/modules/memberships/chat-store");
  const db = {
    storageLocation: { upsert: async () => ({}) },
    uploadSession: {
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
    },
    libraryFile: { updateMany: async () => ({ count: 0 }) },
    $executeRaw: async () => 0,
  };
  class TestDatabaseModule {}
  Module({
    providers: [{ provide: PrismaService, useValue: db }],
    exports: [PrismaService],
  })(TestDatabaseModule);
  class WorkerContextModule {}
  Module({
    imports: [
      ConfigurationModule.forRoot({
        files: { driver: "local", localDirectory: ".preview/worker-context" },
        auth: { accessTokenSecret: "test-only", cookie: { secure: false } },
        port: 4000,
      }),
      { module: TestDatabaseModule, global: true },
      VideoProcessingCoreModule,
    ],
  })(WorkerContextModule);
  const app = await NestFactory.createApplicationContext(WorkerContextModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    assert.ok(app.get(VideoWorker));
    assert.throws(() => app.get(MembershipGateway));
    assert.throws(() => app.get(ChatStore));
  } finally {
    await app.close();
  }
});
