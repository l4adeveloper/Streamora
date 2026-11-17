const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Readable, Writable } = require("node:stream");
const {
  planLiveReplication,
} = require("../dist/modules/video-processing/live-replication-plan");
const {
  StorageReplicationWorker,
} = require("../dist/modules/video-processing/storage-replication.worker");
const {
  GcsReplicaStorage,
} = require("../dist/modules/video-processing/gcs-replica-storage");
const {
  RecordingSourceService,
} = require("../dist/modules/class-recordings/recording-source.service");
const {
  readVideoConfig,
} = require("../dist/modules/video-processing/video-config");

const location = "a".repeat(64),
  prefix = "recording/live";
const tree = {
  [prefix + "/master.m3u8"]:
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nv.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,URI="a.m3u8"\n',
  [prefix + "/v.m3u8"]:
    "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ns1.ts\n#EXTINF:4,\ns2.ts\n",
  [prefix + "/a.m3u8"]:
    "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na1.aac\n",
};
const read = async (key) => {
  if (!tree[key]) throw Error("missing");
  return tree[key];
};

test("storage adapter preserves published live bytes and supports empty raw files", async () => {
  const adapter = new GcsReplicaStorage();
  let writes = 0;
  let metadata = {
    size: "3",
    md5Hash: "verified",
    metadata: { sourceVersion: "version", sourceEtag: '"one"' },
  };
  adapter.gcs = {
    bucket: () => ({
      file: () => ({
        getMetadata: async () => [metadata],
        createWriteStream: () => {
          writes++;
          return new Writable({
            write(_chunk, _enc, cb) {
              cb();
            },
          });
        },
      }),
    }),
  };
  const source = {
    send: async () => ({
      Body: Readable.from([Buffer.from("abc")]),
      ContentLength: 3,
      ETag: '"one"',
    }),
  };
  const signal = new AbortController().signal;
  await adapter.copy(
    source,
    "source",
    "segment",
    "dest",
    "version",
    signal,
    "segment",
    true,
  );
  assert.equal(writes, 0);
  metadata.metadata.sourceEtag = '"changed"';
  await assert.rejects(
    adapter.copy(
      source,
      "source",
      "segment",
      "dest",
      "version",
      signal,
      "segment",
      true,
    ),
    /SOURCE_VERSION_CHANGED/,
  );
  assert.equal(writes, 0);
  metadata = { size: "0", md5Hash: "1B2M2Y8AsgTpgAmY7PhCfg==" };
  await adapter.copy(
    { send: async () => ({ Body: Readable.from([]), ContentLength: 0 }) },
    "source",
    "empty",
    "dest",
    "version",
    signal,
  );
  assert.equal(writes, 1);
});

test("primary live health signs HEAD independently from GET playback URLs", async () => {
  const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const names = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
  const previous = names.map(name => process.env[name]);
  const credentials = { accessKeyId: "TESTONLYACCESSKEY", secretAccessKey: "test-only-signing-secret" };
  process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
  delete process.env.AWS_SESSION_TOKEN;
  const client = new S3Client({ region: "ap-northeast-1", credentials });
  try {
    const service = new RecordingSourceService({}, {}, {}, {}, {},
      { locations: { resolve: async () => ({ driver: "s3", bucket: "test-only-source", region: "ap-northeast-1" }) } },
      { auth: { accessTokenSecret: "test" } });
    const key = "recording/s.ts", live = { recording: { storageLocationId: location }, snapshot: { objects: [key] } };
    const head = new URL((await service.liveSigner(live, "original", [key], true))(key));
    const date = head.searchParams.get("X-Amz-Date");
    const signingDate = new Date(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    const expected = new URL(await getSignedUrl(client, new HeadObjectCommand({ Bucket: "test-only-source", Key: key }), { expiresIn: 900, signingDate }));
    assert.equal(head.searchParams.get("X-Amz-Signature"), expected.searchParams.get("X-Amz-Signature"));
    const get = new URL((await service.liveSigner(live, "original", [key]))(key));
    assert.notEqual(head.searchParams.get("X-Amz-Signature"), get.searchParams.get("X-Amz-Signature"));
  } finally {
    client.destroy();
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  }
});

test("live snapshot permits unfinished event playlists, bounds the common timeline and detects completion", async () => {
  const plan = await planLiveReplication(prefix, prefix + "/master.m3u8", read);
  assert.equal(plan.readyThroughSeconds, 4);
  assert.equal(plan.ended, false);
  assert.equal(plan.objects.length, 3);
  assert.equal(Object.keys(plan.playlists).at(-1), plan.masterKey);
  const ended = await planLiveReplication(
    prefix,
    plan.masterKey,
    async (key) => (await read(key)) + "#EXT-X-ENDLIST\n",
  );
  assert.equal(ended.ended, true);
});

test("live planner rejects sliding timelines, incomplete segments, traversal, encryption and cycles", async () => {
  const master = prefix + "/master.m3u8";
  for (const invalid of [
    "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:4,\ns.ts\n",
    "#EXTM3U\n#EXTINF:4,\n",
    "#EXTM3U\n#EXTINF:4,\nhttps://evil.example/s.ts\n",
    "#EXTM3U\n#EXTINF:4,\n../../escape.ts\n",
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,\ns.ts\n',
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmaster.m3u8\n",
  ])
    await assert.rejects(
      planLiveReplication(prefix, master, async () => invalid),
    );
});

test("live worker commits a snapshot only after all objects; refresh failure retains its safe watermark", async () => {
  const original = GcsReplicaStorage.prototype.copy;
  let writes = [],
    terminal;
  const row = {
    id: randomUUID(),
    kind: "LIVE_DVR",
    assetId: randomUUID(),
    destinationBucket: "replica",
    source: { storageLocationId: location, prefix },
    attempts: 0,
    readyThroughSeconds: 0,
    lastSyncedAt: null,
  };
  const db = {
    storageReplica: {
      count: async () => 1,
      updateMany: async ({ data }) => {
        terminal = data;
        return { count: 1 };
      },
    },
    classRecording: {
      findUnique: async () => ({
        status: "RECORDING",
        storageLocationId: location,
        recordingPrefix: prefix,
      }),
    },
  };
  const storage = {
    locations: {
      resolve: async () => ({ driver: "s3", bucket: "source", region: "test" }),
    },
    list: async () => new Set(Object.keys(tree)),
    text: async (_, key) => read(key),
  };
  const worker = new StorageReplicationWorker(db, storage, {
    video: { replication: { bucket: "replica" } },
  });
  try {
    GcsReplicaStorage.prototype.copy = async (...args) => {
      writes.push(args[2]);
      throw Error("interrupted");
    };
    await worker.replicate(row, randomUUID());
    assert.equal(terminal.status, "FAILED");
    assert.equal(terminal.snapshot, undefined);
    GcsReplicaStorage.prototype.copy = async (...args) => {
      writes.push(args[2]);
      assert.equal(args[7], true);
    };
    writes = [];
    await worker.replicate(row, randomUUID());
    assert.equal(writes.length, 3);
    assert.equal(terminal.status, "READY");
    assert.equal(terminal.readyThroughSeconds, 4);
    assert.equal(terminal.completed, false);
    assert.equal(
      terminal.snapshot.destinationPrefix,
      `replicas/live/${row.assetId}`,
    );
    const committed = terminal;
    GcsReplicaStorage.prototype.copy = async () => {
      throw Error("outage");
    };
    await worker.replicate(
      {
        ...row,
        lastSyncedAt: new Date(),
        readyThroughSeconds: 4,
        snapshot: committed.snapshot,
      },
      randomUUID(),
    );
    assert.equal(terminal.status, "READY");
    assert.equal(terminal.snapshot, undefined);
    assert.equal(terminal.readyThroughSeconds, undefined);
  } finally {
    GcsReplicaStorage.prototype.copy = original;
  }
});

test("raw worker uses isolated object keys, expected size, and refuses deleted source files", async () => {
  const original = GcsReplicaStorage.prototype.copy;
  let terminal,
    deleted = false,
    copies = 0;
  const row = {
    id: randomUUID(),
    kind: "RAW",
    assetId: randomUUID(),
    destinationBucket: "replica",
    source: {
      storageLocationId: location,
      key: "uploads/lesson name.pdf",
      size: "15",
    },
    attempts: 0,
  };
  const db = {
    storageReplica: {
      count: async () => 1,
      updateMany: async ({ data }) => {
        terminal = data;
        return { count: 1 };
      },
    },
    libraryFile: {
      findUnique: async () => ({
        status: "AVAILABLE",
        deletedAt: deleted ? new Date() : null,
        storageLocationId: location,
        objectKey: row.source.key,
        size: 15n,
      }),
    },
  };
  const worker = new StorageReplicationWorker(
    db,
    {
      locations: {
        resolve: async () => ({
          driver: "s3",
          bucket: "source",
          region: "test",
        }),
      },
    },
    { video: { replication: { bucket: "replica" } } },
  );
  try {
    GcsReplicaStorage.prototype.copy = async (...args) => {
      copies++;
      assert.equal(args[2], row.source.key);
      assert.equal(args[6], `replicas/raw/${row.assetId}/object`);
      assert.equal(args[8], 15);
    };
    await worker.replicate(row, randomUUID());
    assert.equal(terminal.completed, true);
    assert.equal(terminal.status, "READY");
    deleted = true;
    await worker.replicate(row, randomUUID());
    assert.equal(copies, 1);
    assert.equal(terminal.status, "FAILED");
  } finally {
    GcsReplicaStorage.prototype.copy = original;
  }
});

test("LIVE_DVR resolver enforces replica watermark, scoped grants and renewed membership", async () => {
  const userId = randomUUID(),
    id = randomUUID();
  const snapshot = await planLiveReplication(
    prefix,
    prefix + "/master.m3u8",
    read,
  );
  const row = {
    lastSyncedAt: new Date(),
    objectCount: 6,
    readyThroughSeconds: 4,
    source: { prefix, storageLocationId: location },
    snapshot: { ...snapshot, destinationPrefix: "replicas/live/" + id },
  };
  let allowed = true;
  const service = new RecordingSourceService(
    { storageReplica: { findUnique: async () => row } },
    {
      recording: async () => {
        if (!allowed) throw Object.assign(Error("denied"), { status: 403 });
        return {
          id,
          provider: "IVS",
          status: "RECORDING",
          recordingPrefix: prefix,
          storageLocationId: location,
        };
      },
    },
    {},
    {},
    {
      gcsSignedObjectFactory: async () => (key) =>
        "https://cdn.example/" + key + "?signed=1",
    },
    {
      list: async () => {
        throw Error("primary down");
      },
    },
    {
      auth: { accessTokenSecret: "fixture", cookie: { secure: false } },
      video: { gcsDelivery: { bucket: "replica" } },
    },
  );
  service.healthy = async () => true;
  const result = await service.resolve(userId, id, {
    mode: "LIVE_DVR",
    positionSeconds: 3,
    failedSourceId: "original",
  });
  assert.equal(result.sourceId, "gcs");
  assert.equal(result.readyThroughSeconds, 4);
  const grant = result.deliveryCookies[0].value;
  const text = await service.playlist(id, id, "gcs", ["v.m3u8"], grant);
  assert.match(text, /https:\/\/cdn.example\/replicas\/live\//);
  await assert.rejects(
    service.resolve(userId, id, { mode: "LIVE_DVR", positionSeconds: 5 }),
  );
  await assert.rejects(
    service.playlist(id, id, "gcs", ["..", "escape.m3u8"], grant),
  );
  await assert.rejects(
    service.playlist(id, randomUUID(), "gcs", ["v.m3u8"], grant),
  );
  allowed = false;
  await assert.rejects(
    service.playlist(id, id, "gcs", ["v.m3u8"], grant),
    /denied/,
  );
});

test("region preference is validated, selects healthy GCS first, and preserves a healthy current source", async () => {
  const config = readVideoConfig(
    { VIDEO_SOURCE_REGION_PREFERENCES: '{"ASIA":"gcs"}' },
    "local",
    "test",
  );
  assert.equal(config.sourceRegionPreferences.ASIA, "gcs");
  for (const input of ["null", "[]", '{"ASIA":"evil"}', '{"asia":"gcs"}', "{"])
    assert.throws(() =>
      readVideoConfig(
        { VIDEO_SOURCE_REGION_PREFERENCES: input },
        "local",
        "test",
      ),
    );
  const output = {
    prefix: "video/one",
    masterKey: "video/one/master.m3u8",
    duration: 20,
    storageLocationId: location,
    renditions: [
      {
        id: "720",
        width: 1280,
        height: 720,
        bitrate: 1000,
        variantKey: "video/one/v.m3u8",
      },
    ],
  };
  const service = new RecordingSourceService(
    {},
    {
      recording: async () => ({
        status: "SAVED",
        fileId: "file",
        file: { status: "AVAILABLE" },
      }),
    },
    {},
    {
      state: async () => ({ published: { id: "job", state: "READY", output } }),
    },
    {},
    {},
    {
      auth: { accessTokenSecret: "test", cookie: { secure: false } },
      video: {
        mode: "aws",
        cloudFrontKeyPairId: "x",
        sourceRegionPreferences: { ASIA: "gcs" },
      },
    },
  );
  service.candidates = async () =>
    ["cloudfront", "gcs"].map((id) => ({ id, sign: (key) => key }));
  service.healthy = async () => true;
  assert.equal(
    (
      await service.resolve("viewer", "recording", {
        mode: "VOD",
        viewerRegion: "ASIA",
      })
    ).sourceId,
    "gcs",
  );
  assert.equal(
    (
      await service.resolve("viewer", "recording", {
        mode: "VOD",
        viewerRegion: "ASIA",
        preferredSourceId: "cloudfront",
      })
    ).sourceId,
    "cloudfront",
  );
  service.healthy = async (choice) => choice.id === "cloudfront";
  assert.equal(
    (
      await service.resolve("viewer", "recording", {
        mode: "VOD",
        viewerRegion: "ASIA",
      })
    ).sourceId,
    "cloudfront",
  );
});
