const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, verify } = require("node:crypto");
const { readVideoLambdaConfig } = require("../dist/video.lambda");
const {
  createVideoLambdaHandler,
} = require("../dist/modules/video-processing/video-lambda-handler");
const {
  VideoWorker,
} = require("../dist/modules/video-processing/video-worker");
const {
  CloudFrontVideoCdn,
} = require("../dist/modules/video-processing/cloudfront-video-cdn");
const {
  VideoDelivery,
} = require("../dist/modules/video-processing/video-delivery");

const env = {
  VIDEO_MODE: "aws",
  VIDEO_WORKER_ENABLED: "false",
  FILES_S3_REGION: "ap-northeast-1",
  FILES_S3_BUCKET: "source-bucket",
  VIDEO_AWS_ACCOUNT_ID: "586481704097",
  VIDEO_OUTPUT_BUCKET: "output-bucket",
  VIDEO_DATABASE_SECRET_ARN:
    "arn:aws:secretsmanager:ap-northeast-1:586481704097:secret:database-abcdef",
  VIDEO_MEDIACONVERT_ROLE_ARN: "arn:aws:iam::586481704097:role/encode",
  VIDEO_MEDIACONVERT_QUEUE_ARN:
    "arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/video",
  VIDEO_DISPATCH_QUEUE_URL:
    "https://sqs.ap-northeast-1.amazonaws.com/586481704097/dispatch",
  VIDEO_COMPLETION_QUEUE_URL:
    "https://sqs.ap-northeast-1.amazonaws.com/586481704097/completion",
};
const config = readVideoLambdaConfig(env);
const context = () => ({
  callbackWaitsForEmptyEventLoop: true,
  getRemainingTimeInMillis: () => 300000,
});
const record = (messageId, queue, body = "{}") => ({
  messageId,
  body,
  eventSource: "aws:sqs",
  eventSourceARN: `arn:aws:sqs:ap-northeast-1:586481704097:${queue}`,
});

test("Lambda config needs processing/DB settings, without API auth or CDN signing keys", () => {
  assert.equal(config.video.signingSecretArn, "");
  assert.equal(config.video.mediaDomain, "");
  assert.equal(config.video.workerEnabled, false);
  for (const update of [
    { VIDEO_MODE: "local" },
    { VIDEO_WORKER_ENABLED: "true" },
    {
      VIDEO_DATABASE_SECRET_ARN:
        "arn:aws:secretsmanager:us-east-1:586481704097:secret:other",
    },
    { VIDEO_MEDIACONVERT_ROLE_ARN: "" },
  ])
    assert.throws(() => readVideoLambdaConfig({ ...env, ...update }));
});

test("Lambda routes trusted queues, returns only failed record IDs and never logs signed inputs", async () => {
  const calls = [],
    logs = [];
  const worker = {
    handleMessage: async (body, completion) => {
      calls.push({ body, completion });
      if (body === "bad") throw new Error("secret signed input URL");
    },
  };
  const handle = createVideoLambdaHandler(config.video, async () => worker);
  const warn = console.warn;
  console.warn = (value) => logs.push(value);
  try {
    const ctx = context();
    const result = await handle(
      {
        Records: [
          record("1", "dispatch"),
          record("2", "completion", "bad"),
          record("3", "foreign"),
        ],
      },
      ctx,
    );
    assert.deepEqual(result, {
      batchItemFailures: [{ itemIdentifier: "2" }, { itemIdentifier: "3" }],
    });
    assert.deepEqual(calls, [
      { body: "{}", completion: false },
      { body: "bad", completion: true },
    ]);
    assert.equal(ctx.callbackWaitsForEmptyEventLoop, false);
    assert.ok(!JSON.stringify(logs).includes("secret signed"));
  } finally {
    console.warn = warn;
  }
});

test("scheduled maintenance has a time budget and does not start a background loop", async () => {
  let calls = 0;
  const handle = createVideoLambdaHandler(config.video, async () => ({
    maintenance: async (remaining) => {
      calls++;
      assert.equal(remaining(), 300000);
    },
  }));
  assert.deepEqual(await handle({ action: "maintenance" }, context()), {
    ok: true,
  });
  assert.equal(calls, 1);
  await assert.rejects(handle({}, context()), /VIDEO_EVENT_INVALID/);
  const noTime = createVideoLambdaHandler(config.video, async () => {
    assert.fail("work started without a time budget");
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(
      await noTime(
        { Records: [record("1", "dispatch")] },
        { ...context(), getRemainingTimeInMillis: () => 1 },
      ),
      { batchItemFailures: [{ itemIdentifier: "1" }] },
    );
  } finally {
    console.warn = warn;
  }
});

test("dispatch acknowledges a durable handoff, retries an unclaimed job and validates DB-bound source", async () => {
  const row = {
    id: "job",
    fileId: "file",
    state: "QUEUED",
    file: { objectKey: "source", recordingId: "recording" },
  };
  const service = {
    config: { video: config.video },
    db: { videoJob: { findUnique: async () => row } },
  };
  const worker = new VideoWorker(service, {});
  worker.sqs = {};
  worker.encoder = {};
  const payload = {
    jobId: "job",
    recordingId: "recording",
    sourceObjectKey: "source",
    outputVersion: "job",
  };
  worker.once = async () => false;
  await assert.rejects(
    worker.handleMessage(JSON.stringify(payload), false),
    /VIDEO_DISPATCH_PENDING/,
  );
  worker.once = async () => {
    row.state = "SUBMITTING";
    return true;
  };
  await worker.handleMessage(JSON.stringify(payload), false); // Durable uncertain submission: schedule can reconcile it.
  row.state = "PROCESSING";
  row.providerJobId = "provider";
  await worker.handleMessage(JSON.stringify(payload), false);
  await assert.rejects(
    worker.handleMessage(
      JSON.stringify({ ...payload, sourceObjectKey: "different" }),
      false,
    ),
    /SOURCE_MISSING/,
  );
});

test("outbox writes its dispatch cursor only after SQS accepts the canonical message", async () => {
  const sent = [],
    committed = [];
  const job = { id: "job", fileId: "file", createdAt: new Date() };
  const worker = new VideoWorker(
    {
      config: { video: config.video },
      db: {
        videoJob: {
          findMany: async () => [job],
          updateMany: async (value) => {
            committed.push(value);
          },
        },
        libraryFile: {
          findUniqueOrThrow: async () => ({
            id: "file",
            objectKey: "source",
            recordingId: "recording",
          }),
        },
      },
    },
    {},
  );
  worker.encoder = {};
  worker.sqs = {
    send: async (command) => {
      sent.push(command.input);
    },
  };
  await worker.dispatch();
  assert.equal(JSON.parse(sent[0].MessageBody).sourceObjectKey, "source");
  assert.equal(committed.length, 1);
  worker.sqs.send = async () => {
    throw new Error("queue unavailable");
  };
  await assert.rejects(worker.dispatch(), /queue unavailable/);
  assert.equal(committed.length, 1);
});

test("terminal completion retries until DB commit and ignores a superseded attempt", async () => {
  const row = { id: "job", state: "PROCESSING", attemptNo: 2, providerJobId: "provider-2" };
  let processed = 0;
  const worker = new VideoWorker({ config: { video: config.video }, db: { videoJob: {
    findUnique: async () => row, updateMany: async () => ({ count: 1 }),
  } } }, {});
  worker.sqs = {}; worker.encoder = {};
  worker.once = async () => { processed++; return false; };
  const event = { source: "aws.mediaconvert", account: "586481704097", region: "ap-northeast-1",
    "detail-type": "MediaConvert Job State Change", detail: { status: "COMPLETE", jobId: "provider-2",
      userMetadata: { project: "streamora", jobId: "job", attemptNo: "2" } } };
  await assert.rejects(worker.handleMessage(JSON.stringify(event), true), /VIDEO_COMPLETION_PENDING/);
  assert.equal(processed, 1);
  const stale = structuredClone(event); stale.detail.jobId = "provider-1"; stale.detail.userMetadata.attemptNo = "1";
  await worker.handleMessage(JSON.stringify(stale), true);
  assert.equal(processed, 1);
  row.state = "READY";
  await worker.handleMessage(JSON.stringify(event), true);
  assert.equal(processed, 1);
});

test("CloudFront signing covers exactly one output tree and unconfigured storage never becomes public", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const video = { ...config.video, mediaDomain: "media.example.com" };
  const provider = new CloudFrontVideoCdn(video);
  provider.secret = {
    keyPairId: "public-key",
    privateKey: keys.privateKey,
    expires: Date.now() + 60000,
  };
  const output = {
    storageLocationId: "a".repeat(64),
    prefix: "groups/g/videos/f/job/1",
    masterKey: "groups/g/videos/f/job/1/hls/master.m3u8",
  };
  const grant = await provider.grant(
    "file",
    output,
    Math.floor(Date.now() / 1000) + 60,
  );
  const decode = (text) =>
    Buffer.from(
      text.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"),
      "base64",
    );
  const policy = decode(
    grant.cookies.find((c) => c.name === "CloudFront-Policy").value,
  );
  const signature = decode(
    grant.cookies.find((c) => c.name === "CloudFront-Signature").value,
  );
  assert.ok(verify("RSA-SHA1", policy, keys.publicKey, signature));
  assert.equal(
    JSON.parse(policy).Statement[0].Resource,
    `https://media.example.com/${output.prefix}/*`,
  );
  assert.equal(grant.cookies.length, 3);
  assert.ok(
    grant.cookies.every(
      (c) => c.secure && c.path === "/" + output.prefix + "/",
    ),
  );
  assert.throws(() => grant.assetUrl("groups/other/master.m3u8"));
  const delivery = new VideoDelivery(
    { video },
    {
      resolve: async () => ({
        driver: "s3",
        bucket: "unmapped",
        region: video.region,
      }),
    },
    [provider],
  );
  await assert.rejects(
    delivery.grant("file", "job", output),
    (error) =>
      error.getStatus() === 503 &&
      error.getResponse().error.code === "VIDEO_DELIVERY_UNAVAILABLE",
  );
});

test("another CDN adapter can own asset URLs without changing the catalog or encoder", async () => {
  const target = { driver: "s3", bucket: "replica", region: "other-region" };
  const adapter = {
    supports: (source) => source.bucket === "replica",
    grant: async () => ({
      url: "https://replica.example/master.m3u8",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      cookies: [],
      assetUrl: (key) => `https://replica.example/${key}?token=temporary`,
    }),
  };
  const delivery = new VideoDelivery(
    { video: config.video },
    { resolve: async () => target },
    [adapter],
  );
  const result = await delivery.grant("file", "job", {
    storageLocationId: "a".repeat(64),
    prefix: "asset",
    masterKey: "asset/master.m3u8",
  });
  assert.equal(
    result.assetUrl("asset/segment.ts"),
    "https://replica.example/asset/segment.ts?token=temporary",
  );
});
