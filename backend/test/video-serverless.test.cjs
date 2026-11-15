const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  MediaConvertEncoder,
  mediaConvertSettings,
  parseMediaConvertProbe,
} = require("../dist/modules/video-processing/mediaconvert-encoder");
const {
  VideoWorker,
} = require("../dist/modules/video-processing/video-worker");
const {
  readVideoConfig,
} = require("../dist/modules/video-processing/video-config");

function media(video = {}, audio = false) {
  return {
    Container: {
      Duration: 2,
      Tracks: [
        {
          TrackType: "video",
          Codec: "AVC",
          VideoProperties: {
            Width: 1920,
            Height: 1080,
            FrameRate: { Numerator: 30000, Denominator: 1001 },
            BitDepth: 8,
            CodecMetadata: { Level: "4.1" },
            ...video,
          },
        },
        ...(audio ? [{ TrackType: "audio", Codec: "AAC" }] : []),
      ],
    },
  };
}

test("managed Probe preserves dimensions, rotation, SAR, audio and rejects invalid/unsupported sources", () => {
  const source = parseMediaConvertProbe(media({}, true));
  assert.equal(source.width, 1920);
  assert.equal(source.fps, 30000 / 1001);
  assert.equal(source.codec, "h264");
  assert.equal(source.level, 41);
  assert.equal(source.audioCodec, "aac");
  assert.equal(parseMediaConvertProbe(media({ Rotation: 90 })).width, 1080);
  assert.equal(
    parseMediaConvertProbe(
      media({ SampleAspectRatio: { Numerator: 2, Denominator: 1 } }),
    ).width,
    3840,
  );
  // MPEG-TS can report rate/color/dimensions only in codec metadata.
  const ts = media({
    Width: undefined,
    Height: undefined,
    FrameRate: undefined,
    CodecMetadata: {
      Width: 1280,
      Height: 720,
      CodedFrameRate: { Numerator: 30, Denominator: 1 },
    },
  });
  assert.equal(parseMediaConvertProbe(ts).width, 1280);
  for (const video of [
    { BitDepth: 10 },
    { TransferCharacteristics: "SMPTE_2084" },
    { CodecMetadata: { TransferCharacteristics: "ARIB_B67" } },
  ])
    assert.throws(
      () => parseMediaConvertProbe(media(video)),
      /HDR_UNSUPPORTED/,
    );
  assert.throws(() => parseMediaConvertProbe(), /SOURCE_INVALID/);
  assert.throws(
    () =>
      parseMediaConvertProbe(
        media({ FrameRate: { Numerator: 0, Denominator: 0 } }),
      ),
    /SOURCE_INVALID/,
  );
  const multiple = media({}, true);
  multiple.Container.Tracks.push({ TrackType: "audio", Codec: "AAC" });
  assert.throws(
    () => parseMediaConvertProbe(multiple),
    /MULTIPLE_AUDIO_UNSUPPORTED/,
  );
});

test("AWS metadata uses MediaConvert Probe with the server-bound URL", async () => {
  const encoder = new MediaConvertEncoder({ region: "ap-northeast-1" });
  try {
    encoder.client.send = async (command) => {
      assert.equal(command.constructor.name, "ProbeCommand");
      assert.deepEqual(command.input, {
        InputFiles: [{ FileUrl: "https://source.test/signed" }],
      });
      return { ProbeResults: [media()] };
    };
    assert.equal(
      (await encoder.probe("https://source.test/signed")).height,
      1080,
    );
  } finally {
    encoder.client.destroy();
  }
});

const awsEnv = {
  VIDEO_MODE: "aws",
  VIDEO_DYNAMODB_TABLE: "streamora-video-jobs",
  VIDEO_WORKER_ENABLED: "false",
  VIDEO_AWS_ACCOUNT_ID: "123456789012",
  VIDEO_OUTPUT_BUCKET: "streamora-video-test",
  VIDEO_MEDIACONVERT_ROLE_ARN: "arn:aws:iam::123456789012:role/video",
  VIDEO_MEDIACONVERT_QUEUE_ARN:
    "arn:aws:mediaconvert:ap-northeast-1:123456789012:queues/video",
  VIDEO_MEDIA_DOMAIN: "media.example.com",
};

test("AWS uses Lambda and DynamoDB without starting a background worker on the API", async () => {
  const config = readVideoConfig(awsEnv, "s3", "ap-northeast-1");
  const worker = new VideoWorker({ config: { video: config } }, {});
  await worker.onApplicationBootstrap();
  assert.equal(worker.running, undefined);
  await assert.rejects(worker.start(), /AWS_VIDEO_REQUIRES_LAMBDA/);
  for (const change of [
    { VIDEO_WORKER_ENABLED: "true" },
    { VIDEO_WORKER_ENABLED: "yes" },
    { VIDEO_DYNAMODB_TABLE: "" },
  ])
    assert.throws(() =>
      readVideoConfig({ ...awsEnv, ...change }, "s3", "ap-northeast-1"),
    );
  assert.throws(() =>
    readVideoConfig(
      { ...awsEnv, VIDEO_MEDIACONVERT_ROLE_ARN: "" },
      "s3",
      "ap-northeast-1",
      "lambda",
    ),
  );
});

test("AWS submission and finalization use managed metadata and publish only verified S3 output", async () => {
  const config = readVideoConfig(awsEnv, "s3", "ap-northeast-1");
  const prefix = "groups/group/videos/file/job/1";
  const job = {
    id: "job",
    fileId: "file",
    attemptNo: 1,
    encoder: "mediaconvert",
    state: "PROCESSING",
    errorCount: 0,
  };
  const objects = new Map();
  const published = [],
    failures = [],
    probes = [];
  const service = {
    config: { video: config },
    heartbeat: async () => true,
    publish: async (_job, output) => {
      published.push(output);
      return true;
    },
    fail: async (_job, code) => {
      failures.push(code);
    },
    load: async () => ({
      file: { id: "file", groupId: "group", status: "AVAILABLE" },
      asset: {
        source: {
          kind: "FILE",
          storageLocationId: "a".repeat(64),
          key: "source.mp4",
        },
      },
    }),
    saveMetadata: async () => {},
    outputLocation: async () => "b".repeat(64),
    update: async (_job, data) => {
      Object.assign(job, data);
      return true;
    },
  };
  const storage = {
    locations: {
      resolve: async (id) => ({
        driver: "s3",
        bucket: id === "a".repeat(64) ? "source" : config.outputBucket,
      }),
    },
    input: async (_location, key) => key,
    list: async () => new Set(objects.keys()),
    text: async (_location, key) => objects.get(key),
    exists: async (_location, key) => objects.has(key),
  };
  const worker = new VideoWorker(service, storage, {
    importLocalFile: () => assert.fail("AWS encoded locally"),
  });
  let submitted;
  worker.encoder = {
    probe: async (key) => {
      probes.push(key);
      const rendition = job.policy?.renditions.find((r) =>
        key.endsWith(`_${r.id}.ts`),
      );
      return parseMediaConvertProbe(
        media(
          rendition ? { Width: rendition.width, Height: rendition.height } : {},
        ),
      );
    },
    start: async (request) => {
      submitted = mediaConvertSettings(
        request.source,
        request.destination,
        request.policy,
      );
      return "provider";
    },
    status: async (_id, { source, destination, policy }) => {
      assert.equal(source, "s3://source/source.mp4");
      assert.equal(destination, `s3://${config.outputBucket}/${prefix}`);
      assert.equal(policy.renditions.length, 3);
      return { state: "COMPLETE" };
    },
  };
  await worker.process({ ...job });
  assert.deepEqual(failures, []);
  assert.equal(job.providerJobId, "provider");
  assert.equal(submitted.OutputGroups[0].Outputs.length, 3);
  assert.equal(published.length, 0);
  const manifest = ["#EXTM3U"];
  for (const r of job.policy.renditions) {
    manifest.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bitrate},RESOLUTION=${r.width}x${r.height},CODECS="avc1.640029"`,
      `master_${r.id}.m3u8`,
    );
    objects.set(
      `${prefix}/hls/master_${r.id}.m3u8`,
      `#EXTM3U\n#EXTINF:2,\nmaster_${r.id}.ts\n#EXT-X-ENDLIST\n`,
    );
    objects.set(`${prefix}/hls/master_${r.id}.ts`, "segment");
  }
  objects.set(`${prefix}/hls/master.m3u8`, manifest.join("\n") + "\n");
  objects.set(`${prefix}/thumbnails/poster_capture.0000000.jpg`, "jpeg");
  await worker.process({ ...job });
  assert.deepEqual(failures, []);
  assert.equal(published.length, 1);
  assert.equal(published[0].renditions.length, 3);
  assert.ok(published[0].thumbnailKey);
  assert.equal(probes.length, 4); // Source plus one actual segment per rendition.
  objects.delete(`${prefix}/hls/master_360p.ts`);
  await worker.process({ ...job });
  assert.equal(published.length, 1); // Missing output must never be published.
  for (const status of [403, 400, 503]) {
    Object.assign(job, {
      state: "PROCESSING",
      providerJobId: null,
      policy: null,
      errorCount: 0,
    });
    worker.encoder.start = async () => {
      throw new (require("../dist/modules/video-processing/video-policy").VideoError)(
        status === 503
          ? "SUBMISSION_UNCERTAIN"
          : status === 403
            ? "PROVIDER_ACCESS_DENIED"
            : "ENCODE_FAILED",
      );
    };
    const before = failures.length;
    await worker.process({ ...job });
    if (status === 503) {
      assert.equal(failures.length, before);
      assert.equal(job.state, "SUBMITTING");
    } else
      assert.equal(
        failures.at(-1),
        status === 403 ? "PROVIDER_ACCESS_DENIED" : "ENCODE_FAILED",
      );
  }
});

test("managed adapter normalizes definitive rejections and ambiguous submissions", async () => {
  const encoder = new MediaConvertEncoder(
    readVideoConfig(awsEnv, "s3", "ap-northeast-1"),
  );
  try {
    for (const status of [400, 403, 408, 429, 503]) {
      encoder.submit = async () => {
        throw { $metadata: { httpStatusCode: status } };
      };
      await assert.rejects(
        encoder.start({
          source: "source",
          destination: "dest",
          policy: { renditions: [] },
        }),
        new RegExp(
          status === 403
            ? "PROVIDER_ACCESS_DENIED"
            : status === 400
              ? "ENCODE_FAILED"
              : "SUBMISSION_UNCERTAIN",
        ),
      );
    }
  } finally {
    encoder.close();
  }
});
