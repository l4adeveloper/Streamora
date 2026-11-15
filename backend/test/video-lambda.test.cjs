const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  readVideoLambdaConfig,
  createVideoLambdaHandler,
} = require("../dist/video.lambda");
const env = {
  NODE_ENV: "production",
  VIDEO_MODE: "aws",
  VIDEO_WORKER_ENABLED: "false",
  FILES_S3_REGION: "ap-northeast-1",
  FILES_S3_BUCKET: "video-source",
  VIDEO_DYNAMODB_TABLE: "video-jobs",
  VIDEO_AWS_ACCOUNT_ID: "123456789012",
  VIDEO_OUTPUT_BUCKET: "video-output",
  VIDEO_MEDIACONVERT_ROLE_ARN: "arn:aws:iam::123456789012:role/video",
  VIDEO_MEDIACONVERT_QUEUE_ARN:
    "arn:aws:mediaconvert:ap-northeast-1:123456789012:queues/video",
};
const config = readVideoLambdaConfig(env);
const context = (time = 300000) => ({ getRemainingTimeInMillis: () => time });
test("Lambda config needs DynamoDB and processing settings, with no database or API/CDN secrets", () => {
  assert.equal(config.video.tableName, "video-jobs");
  assert.equal(config.video.workerEnabled, false);
  for (const update of [
    { VIDEO_DYNAMODB_TABLE: "" },
    { VIDEO_WORKER_ENABLED: "true" },
    { VIDEO_MEDIACONVERT_ROLE_ARN: "" },
  ])
    assert.throws(() => readVideoLambdaConfig({ ...env, ...update }));
});

test("maintenance recovers DynamoDB jobs within its time budget without a polling loop or SQL", async () => {
  const calls = [];
  let remaining = 300000;
  const handler = createVideoLambdaHandler(config, () => ({
    store: {
      due: async () => [{ id: "1" }, { id: "2" }],
      cleanup: async () => calls.push("cleanup"),
    },
    storage: {},
    worker: {
      once: async (id) => {
        calls.push(id);
        remaining = 1000;
      },
    },
  }));
  await handler(
    { action: "maintenance" },
    { getRemainingTimeInMillis: () => remaining },
  );
  assert.deepEqual(calls, ["1"]);
  await assert.rejects(handler({}, context()), /VIDEO_EVENT_INVALID/);
});

test("MVP Lambda config derives fixed resource names and uses the default queue", () => {
  const minimal = readVideoLambdaConfig({
    VIDEO_AWS_ACCOUNT_ID: "123456789012",
  });
  assert.equal(minimal.sourceBucket, "streamora-file-storage");
  assert.equal(minimal.video.outputBucket, "streamora-file-storage-output");
  assert.equal(minimal.video.tableName, "streamora-video-jobs");
  assert.equal(
    minimal.video.queueArn,
    "arn:aws:mediaconvert:ap-northeast-1:123456789012:queues/Default",
  );
  assert.equal(
    minimal.video.roleArn,
    "arn:aws:iam::123456789012:role/streamora-video-mediaconvert",
  );
});
test("one failed scheduled job does not block later jobs or expose secrets", async () => {
  const calls = [],
    logs = [],
    warn = console.warn;
  console.warn = (value) => logs.push(value);
  try {
    const handler = createVideoLambdaHandler(config, () => ({
      store: {
        due: async () => [{ id: "bad" }, { id: "good" }],
        cleanup: async () => calls.push("cleanup"),
      },
      storage: {},
      worker: {
        once: async (id) => {
          calls.push(id);
          if (id === "bad") throw new Error("private-key");
        },
      },
    }));
    assert.deepEqual(await handler({ action: "maintenance" }, context()), {
      ok: true,
    });
    assert.deepEqual(calls, ["bad", "good", "cleanup"]);
    assert.ok(!JSON.stringify(logs).includes("private-key"));
    await assert.rejects(
      handler({ Records: [] }, context()),
      /VIDEO_EVENT_INVALID/,
    );
  } finally {
    console.warn = warn;
  }
});
