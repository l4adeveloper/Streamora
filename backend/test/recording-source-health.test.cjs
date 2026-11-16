const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  RecordingSourceService,
} = require("../dist/modules/class-recordings/recording-source.service");
const {
  readVideoConfig,
} = require("../dist/modules/video-processing/video-config");

test("source health uses bounded HEAD requests and caches failures independently per version", async () => {
  const service = new RecordingSourceService(
    {},
    {},
    {},
    {},
    {},
    {},
    { auth: { accessTokenSecret: "test-only" } },
  );
  const previous = global.fetch;
  let count = 0,
    up = false;
  global.fetch = async (url, options) => {
    count++;
    assert.equal(url, "https://cdn.example/job/master.m3u8");
    assert.equal(options.method, "HEAD");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(null, { status: up ? 200 : 503 });
  };
  const candidate = {
    id: "gcs",
    sign: () => "https://cdn.example/job/master.m3u8",
  };
  try {
    assert.equal(await service.healthy(candidate, "job-1", "master"), false);
    up = true;
    assert.equal(await service.healthy(candidate, "job-1", "master"), false);
    assert.equal(count, 1);
    assert.equal(await service.healthy(candidate, "job-2", "master"), true);
    assert.equal(await service.healthy(candidate, "job-2", "master"), true);
    assert.equal(count, 2);
  } finally {
    global.fetch = previous;
  }
});

test("deployments without private CDN settings retain the existing file playback path", async () => {
  const service = new RecordingSourceService(
    {},
    {
      recording: async () => ({
        status: "SAVED",
        fileId: "file",
        file: { status: "AVAILABLE" },
      }),
    },
    {
      playback: async (user, file) => {
        assert.equal(user, "viewer");
        assert.equal(file, "file");
        return {
          fileId: file,
          sources: [
            {
              id: "original",
              kind: "file",
              url: "https://existing.example/video",
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          ],
          processing: { status: "READY" },
        };
      },
    },
    { state: async () => ({ published: { state: "READY", output: {} } }) },
    {},
    {},
    {
      auth: { accessTokenSecret: "test-only" },
      video: { mode: "aws", cloudFrontKeyPairId: "" },
    },
  );
  const result = await service.resolve("viewer", "recording", { mode: "VOD" });
  assert.equal(result.sourceId, "original");
  assert.equal(result.fallbackAvailable, false);
  assert.equal(result.sources[0].url, "https://existing.example/video");
});

test("GCS delivery configuration requires the complete private origin and explicit project", () => {
  const env = {
    VIDEO_MODE: "aws",
    VIDEO_AWS_ACCOUNT_ID: "123456789012",
    VIDEO_MEDIA_DOMAIN: "primary.example",
    VIDEO_GCS_REPLICA_BUCKET: "replica-test",
    VIDEO_GCS_PROJECT_ID: "project-test",
    VIDEO_GCS_CDN_DOMAIN: "replica.example",
    VIDEO_GCS_CDN_KEY_NAME: "v2",
    VIDEO_GCS_CDN_SIGNING_SECRET_ID: "test-secret",
  };
  const configured = readVideoConfig(env, "s3", "ap-northeast-1");
  assert.equal(configured.gcsDelivery.projectId, "project-test");
  for (const field of [
    "VIDEO_GCS_PROJECT_ID",
    "VIDEO_GCS_REPLICA_BUCKET",
    "VIDEO_GCS_CDN_KEY_NAME",
    "VIDEO_GCS_CDN_SIGNING_SECRET_ID",
  ]) {
    const invalid = { ...env };
    delete invalid[field];
    assert.throws(() => readVideoConfig(invalid, "s3", "ap-northeast-1"));
  }
  assert.throws(() =>
    readVideoConfig(
      { ...env, VIDEO_GCS_CDN_DOMAIN: "replica.example/path" },
      "s3",
      "ap-northeast-1",
    ),
  );
  assert.throws(() =>
    readVideoConfig(
      { ...env, VIDEO_GCS_CDN_DOMAIN: "replica.example?token=secret" },
      "s3",
      "ap-northeast-1",
    ),
  );
});
