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
function record(id, changes = {}) {
  return {
    eventID: "event-" + id,
    eventSource: "aws:dynamodb",
    eventName: "INSERT",
    eventSourceARN:
      "arn:aws:dynamodb:ap-northeast-1:123456789012:table/video-jobs/stream/date",
    dynamodb: {
      SequenceNumber: "sequence-" + id,
      NewImage: { kind: { S: "JOB" }, state: { S: "QUEUED" }, id: { S: id } },
    },
    ...changes,
  };
}

test("Lambda config needs DynamoDB and processing settings, with no database or API/CDN secrets", () => {
  assert.equal(config.video.tableName, "video-jobs");
  assert.equal(config.video.signingSecretArn, "");
  assert.equal(config.video.workerEnabled, false);
  for (const update of [
    { VIDEO_DYNAMODB_TABLE: "" },
    { VIDEO_WORKER_ENABLED: "true" },
    { VIDEO_MEDIACONVERT_ROLE_ARN: "" },
  ])
    assert.throws(() => readVideoLambdaConfig({ ...env, ...update }));
});

test("DynamoDB inserts start work immediately; updates are ignored and failures return sequence numbers", async () => {
  const calls = [],
    logs = [];
  const handler = createVideoLambdaHandler(config, () => ({
    store: {},
    storage: {},
    worker: {
      once: async (id) => {
        calls.push(id);
        if (id === "bad") throw new Error("private-url-secret");
      },
    },
  }));
  const warn = console.warn;
  console.warn = (value) => logs.push(value);
  try {
    const result = await handler(
      {
        Records: [
          record("good"),
          record("bad"),
          record("changed", { eventName: "MODIFY" }),
          record("foreign", { eventSourceARN: "arn:aws:dynamodb:other" }),
        ],
      },
      context(),
    );
    assert.deepEqual(calls, ["good", "bad"]);
    assert.deepEqual(result.batchItemFailures, [
      { itemIdentifier: "sequence-bad" },
      { itemIdentifier: "sequence-foreign" },
    ]);
    assert.ok(!JSON.stringify(logs).includes("private-url-secret"));
    assert.equal(
      (await handler({ Records: [record("late")] }, context(1)))
        .batchItemFailures[0].itemIdentifier,
      "sequence-late",
    );
  } finally {
    console.warn = warn;
  }
});

test("completion validates provider identity, ignores stale attempts and retries until durable terminal state", async () => {
  const row = {
    id: "job",
    attemptNo: 2,
    state: "PROCESSING",
    providerJobId: "provider",
  };
  let calls = 0;
  const handler = createVideoLambdaHandler(config, () => ({
    store: { job: async () => row, expedite: async () => {} },
    storage: {},
    worker: {
      once: async () => {
        calls++;
      },
    },
  }));
  const event = {
    source: "aws.mediaconvert",
    account: env.VIDEO_AWS_ACCOUNT_ID,
    region: env.FILES_S3_REGION,
    "detail-type": "MediaConvert Job State Change",
    detail: {
      status: "COMPLETE",
      jobId: "provider",
      userMetadata: { project: "streamora", jobId: "job", attemptNo: "2" },
    },
  };
  await assert.rejects(handler(event, context()), /VIDEO_COMPLETION_PENDING/);
  assert.equal(calls, 1);
  await assert.rejects(
    handler({ ...event, account: "000000000000" }, context()),
    /VIDEO_EVENT_INVALID/,
  );
  await assert.rejects(
    handler(
      { ...event, detail: { ...event.detail, jobId: "wrong-provider" } },
      context(),
    ),
    /PROVIDER_MISMATCH/,
  );
  await handler(
    {
      ...event,
      detail: {
        ...event.detail,
        userMetadata: { ...event.detail.userMetadata, attemptNo: "1" },
      },
    },
    context(),
  );
  assert.equal(calls, 1);
  row.state = "READY";
  await handler(event, context());
  assert.equal(calls, 1);
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
