const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const {
  createVideoDynamoFixture,
  videoJob,
} = require("./video-dynamodb-fixture.cjs");
let f;
before(async () => {
  f = await createVideoDynamoFixture();
});
after(async () => {
  await f?.cleanup();
});
async function dueNow(id) {
  await f.client.send(
    new UpdateCommand({
      TableName: f.video.tableName,
      Key: { pk: "JOB#" + id, sk: "DATA" },
      UpdateExpression: "SET dueAt=:now, nextRunAt=:date",
      ExpressionAttributeValues: {
        ":now": Date.now() - 1000,
        ":date": new Date(Date.now() - 1000).toISOString(),
      },
    }),
  );
}
async function seed(changes = {}) {
  const job = videoJob(undefined, changes);
  const file = { id: job.fileId, groupId: randomUUID() };
  await f.store.ensure(job, file, f.source, f.target);
  return { job, file };
}
function output(file, job) {
  const prefix = `groups/${file.groupId}/videos/${file.id}/${job.id}/1`;
  return {
    storageLocationId: "a".repeat(64),
    prefix,
    masterKey: prefix + "/hls/master.m3u8",
    duration: 2,
    renditions: [],
  };
}

test("concurrent delivery is idempotent; a committed job and its source are atomically visible", async () => {
  const job = videoJob(),
    file = { id: job.fileId, groupId: randomUUID() };
  await Promise.all(
    Array.from({ length: 6 }, () =>
      f.store.ensure(job, file, f.source, f.target),
    ),
  );
  const state = await f.store.state(file.id);
  assert.equal(state.job.id, job.id);
  assert.equal(state.asset.currentJobId, job.id);
  assert.deepEqual(state.asset.source, f.source);
  assert.deepEqual(await f.store.resolve(f.source.storageLocationId), f.target);
  await assert.rejects(
    f.store.putLocation({ ...f.target, bucket: "untrusted-bucket" }),
    /VIDEO_SOURCE_NOT_CLOUD/,
  );
});

test("only one Lambda claims a lease; an expired owner cannot change, fail or publish the newer attempt", async () => {
  const { job, file } = await seed();
  const claims = await Promise.all([
    f.store.claim(randomUUID(), job.id),
    f.store.claim(randomUUID(), job.id),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean);
  await f.client.send(
    new UpdateCommand({
      TableName: f.video.tableName,
      Key: { pk: "JOB#" + job.id, sk: "DATA" },
      UpdateExpression: "SET leaseUntil=:past, dueAt=:past",
      ExpressionAttributeValues: { ":past": Date.now() - 1000 },
    }),
  );
  const second = await f.store.claim(randomUUID(), job.id);
  assert.equal(second.attemptNo, first.attemptNo);
  assert.equal(await f.store.update(first, { state: "SUBMITTING" }), false);
  assert.equal(await f.store.publish(first, output(file, job)), false);
  await assert.rejects(f.store.fail(first, "OLD_OWNER"), /LEASE_LOST/);
  assert.equal(
    await f.store.update(second, {
      policy: { version: 1 },
      errorCount: { increment: 1 },
      submittedAt: new Date(),
    }),
    true,
  );
  assert.equal(await f.store.heartbeat(second, 50), true);
  assert.equal((await f.store.job(job.id)).errorCount, 1);
  assert.equal(await f.store.publish(second, output(file, job)), true);
  const state = await f.store.state(file.id);
  assert.equal(state.job.state, "READY");
  assert.equal(state.job.progressPercent, 100);
  assert.equal(state.asset.publishedJobId, job.id);
  assert.equal(await f.store.update(second, { state: "FAILED" }), false);
});

test("retry switches current job atomically while retaining an older published output", async () => {
  const old = videoJob(undefined, { state: "READY", output: { valid: true } });
  const failed = videoJob(old.fileId, { state: "FAILED" });
  const file = { id: old.fileId, groupId: randomUUID() };
  await f.store.ensure(failed, file, f.source, f.target, old);
  const retry = videoJob(old.fileId);
  await f.store.ensure(retry, file, f.source, f.target);
  const state = await f.store.state(file.id);
  assert.equal(state.job.id, retry.id);
  assert.equal(state.published.id, old.id);
  await assert.rejects(
    f.store.ensure(videoJob(old.fileId), file, f.source, f.target),
  );
  await assert.rejects(f.store.deleted(file.id), /VIDEO_DISPATCH_PENDING/);
});

test("recovery queries only due active jobs and terminal failure removes a job from the active index", async () => {
  const { job } = await seed();
  assert.ok((await f.store.due(100)).some((j) => j.id === job.id));
  const claim = await f.store.claim(randomUUID(), job.id);
  await f.store.update(claim, {
    leaseOwner: null,
    leaseUntil: null,
    nextRunAt: new Date(Date.now() + 60000),
  });
  assert.equal(await f.store.claim(randomUUID(), job.id), null);
  await dueNow(job.id);
  const resumed = await f.store.claim(randomUUID(), job.id);
  await f.store.fail(resumed, "ENCODE_FAILED");
  assert.equal((await f.store.job(job.id)).errorCode, "ENCODE_FAILED");
  assert.ok(!(await f.store.due(100)).some((j) => j.id === job.id));
});
test("the complete managed pipeline publishes verified HLS using DynamoDB and S3 adapters without PostgreSQL", async () => {
  const {
    VideoWorker,
  } = require("../dist/modules/video-processing/video-worker");
  const { job, file } = await seed();
  const objects = new Map();
  let policy,
    submitted = 0;
  const metadata = {
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 2,
    audio: false,
    codec: "h264",
    level: 41,
  };
  const storage = {
    locations: f.store,
    input: async (_id, name) => name,
    list: async () => new Set(objects.keys()),
    text: async (_id, name) => objects.get(name),
    exists: async (_id, name) => objects.has(name),
  };
  const encoder = {
    probe: async (name) => {
      const r = policy?.renditions.find((r) =>
        name.endsWith("_" + r.id + ".ts"),
      );
      return {
        ...metadata,
        ...(r ? { width: r.width, height: r.height } : {}),
      };
    },
    start: async (request) => {
      submitted++;
      policy = request.policy;
      assert.equal(request.source, `s3://${f.target.bucket}/${f.source.key}`);
      return "managed-provider-job";
    },
    status: async () => ({ state: "COMPLETE" }),
    close: () => {},
  };
  const worker = new VideoWorker(f.store, storage, undefined, encoder);
  const { createVideoLambdaHandler } = require("../dist/video.lambda");
  const tick = createVideoLambdaHandler({ video: f.video, sourceBucket: f.target.bucket }, () => ({ store: { due: async () => (await f.store.due(100)).filter(row => row.id === job.id), cleanup: async () => {} }, storage, worker }));
  const context = { getRemainingTimeInMillis: () => 300000 };
  try {
    assert.deepEqual(await tick({ action: "maintenance" }, context), { ok: true });
    assert.equal((await f.store.job(job.id)).state, "PROCESSING");
    assert.equal(submitted, 1);
    const prefix = `groups/${file.groupId}/videos/${file.id}/${job.id}/1`;
    const manifest = ["#EXTM3U"];
    for (const r of policy.renditions) {
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
    await dueNow(job.id);
    assert.deepEqual(await tick({ action: "maintenance" }, context), { ok: true });
    const state = await f.store.state(file.id);
    assert.equal(state.job.state, "READY");
    assert.equal(state.job.output.renditions.length, 3);
    assert.equal(state.asset.publishedJobId, job.id);
    assert.equal(await worker.once(job.id), false);
    assert.equal(
      submitted,
      1,
      "duplicate invocations must not resubmit encoding",
    );
  } finally {
    await worker.onModuleDestroy();
  }
});

test("retention keeps published or HLS-referenced output and fences imports before deleting retired trees", async () => {
  const { job, file } = await seed();
  const location = await f.store.outputLocation();
  const result = { ...output(file, job), storageLocationId: location };
  const claim = await f.store.claim(randomUUID(), job.id);
  await f.store.publish(claim, result);
  const due = () =>
    f.client.send(
      new UpdateCommand({
        TableName: f.video.tableName,
        Key: { pk: "JOB#" + job.id, sk: "DATA" },
        UpdateExpression: "SET dueAt=:past",
        ExpressionAttributeValues: { ":past": Date.now() - 1 },
      }),
    );
  const removed = [];
  await due();
  await f.store.cleanup(
    async (_location, prefix) => removed.push(prefix),
    () => 300000,
  );
  assert.deepEqual(removed, []);
  const source = {
    kind: "HLS",
    storageLocationId: location,
    prefix: result.prefix,
    masterKey: result.masterKey,
    channelType: "STANDARD",
    renditionSelection: "ALL",
    expectedHeights: [1080],
  };
  const imported = videoJob(undefined, {
    state: "READY",
    mode: "IMPORT_HLS",
    encoder: "ivs",
    output: result,
  });
  const importedFile = { id: imported.fileId, groupId: file.groupId };
  await f.store.ensure(
    imported,
    importedFile,
    source,
    await f.store.resolve(location),
    imported,
  );
  await f.store.deleted(file.id);
  await due();
  await f.store.cleanup(
    async (_location, prefix) => removed.push(prefix),
    () => 300000,
  );
  assert.deepEqual(removed, [], "an HLS import must keep its source output");
  const late = videoJob(undefined, { mode: "IMPORT_HLS", encoder: "ivs" });
  await assert.rejects(
    f.store.ensure(
      late,
      { id: late.fileId, groupId: file.groupId },
      source,
      await f.store.resolve(location),
    ),
  );
  await f.store.deleted(imported.fileId);
  await due();
  await f.store.cleanup(
    async (_location, prefix) => removed.push(prefix),
    () => 300000,
  );
  assert.deepEqual(removed, [result.prefix.slice(0, -2)]);
  assert.ok(!(await f.store.due(100, "RETIRED")).some((j) => j.id === job.id));
});
