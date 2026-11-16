const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readEnvironment } = require("../dist/config/environment");
const { IvsService } = require("../dist/modules/class-media/ivs.service");
const {
  VideoDelivery,
} = require("../dist/modules/video-processing/video-delivery");

function config(overrides = {}) {
  return readEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@127.0.0.1/test",
    ACCESS_TOKEN_SECRET: "test-secret-".repeat(5),
    IVS_ENABLED: "true",
    AWS_REGION: "ap-northeast-1",
    FILES_STORAGE_DRIVER: "s3",
    FILES_S3_BUCKET: "existing-bucket",
    FILES_S3_REGION: "ap-northeast-1",
    VIDEO_MODE: "local",
    VIDEO_WORKER_ENABLED: "true",
    IVS_RECORDING_STORAGE_ARN:
      "arn:aws:ivs:ap-northeast-1:123456789012:storage-configuration/test",
    IVS_RECORDING_ENCODER_ARN:
      "arn:aws:ivs:ap-northeast-1:123456789012:encoder-configuration/test",
    ...overrides,
  });
}

test("cloud recording can run alongside the existing SQS consumer", () => {
  const c = config({
    IVS_WORKER_ENABLED: "true",
    IVS_EVENTS_QUEUE_URL:
      "https://sqs.ap-northeast-1.amazonaws.com/123456789012/existing-events",
  });
  assert.equal(c.ivs.workerEnabled, true);
  assert.ok(c.ivs.eventsQueueUrl.endsWith("/existing-events"));
  assert.ok(c.ivs.recording.storageArn);
});

test("an uncertain IVS start recovers its tagged composition instead of creating a second recording", async () => {
  const service = new IvsService(config());
  let starts = 0;
  service.client.send = async (command) => {
    if (command.constructor.name === "ListCompositionsCommand")
      return {
        compositions: [
          { arn: "existing", tags: { streamoraRecordingId: "recording" } },
        ],
      };
    if (command.constructor.name === "GetCompositionCommand")
      return { composition: { arn: "existing", state: "ACTIVE" } };
    starts++;
    throw new Error("Unexpected duplicate start");
  };
  try {
    assert.equal(
      (await service.startRecording("stage", "recording")).arn,
      "existing",
    );
    assert.equal(starts, 0);
  } finally {
    service.onModuleDestroy();
  }
});

test("only a missing composition is treated as gone; permission/network failures never finalize it", async () => {
  const service = new IvsService(config());
  try {
    service.client.send = async () => {
      throw Object.assign(new Error(), { name: "AccessDeniedException" });
    };
    await assert.rejects(service.recording("composition"), {
      name: "AccessDeniedException",
    });
    await assert.rejects(service.stopRecording("composition"), {
      name: "AccessDeniedException",
    });
    service.client.send = async () => {
      throw Object.assign(new Error(), { name: "ResourceNotFoundException" });
    };
    assert.equal(await service.recording("composition"), null);
    await service.stopRecording("composition");
  } finally {
    service.onModuleDestroy();
  }
});

test("S3 MVP processing and private HLS delivery need no managed-video or CDN configuration", async () => {
  const c = config();
  assert.equal(c.video.mode, "local");
  assert.equal(c.video.workerEnabled, true);
  assert.equal(c.ivs.workerEnabled, false);
  assert.equal(c.ivs.eventsQueueUrl, "");
  const delivery = new VideoDelivery(c, {
    resolve: async () => ({
      driver: "s3",
      bucket: "existing-bucket",
      region: "ap-northeast-1",
    }),
  });
  const grant = await delivery.grant("file", "job", {
    storageLocationId: "a".repeat(64),
    prefix: "video/job",
    masterKey: "video/job/master.m3u8",
    renditions: [],
    duration: 2,
  });
  assert.match(grant.url, /\/video-media\/file\/job\/master.m3u8$/);
  assert.equal(grant.cookies.length, 1);
  assert.equal(
    delivery.verify(grant.cookies[0].value, "file", "job").location,
    "a".repeat(64),
  );
  assert.throws(() => delivery.verify(grant.cookies[0].value, "other", "job"));
});
