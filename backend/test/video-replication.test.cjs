const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  planVodReplication,
} = require("../dist/modules/video-processing/replication-plan");
const {
  VideoReplicationWorker,
} = require("../dist/modules/video-processing/video-replication.worker");
const {
  GcsReplicaStorage,
} = require("../dist/modules/video-processing/gcs-replica-storage");

const output = {
  storageLocationId: "a".repeat(64),
  prefix: "video/version1",
  masterKey: "video/version1/master.m3u8",
  renditions: [{ variantKey: "video/version1/720.m3u8" }],
  thumbnailKey: "video/version1/poster.jpg",
};
const tree = {
  "video/version1/master.m3u8":
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720.m3u8\n',
  "video/version1/720.m3u8":
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nsegment.m4s\n#EXT-X-ENDLIST\n',
  "video/version1/audio.m3u8":
    "#EXTM3U\n#EXTINF:4,\naudio.aac\n#EXT-X-ENDLIST\n",
};
test("replication plans all HLS objects including audio and init before master", async () => {
  const plan = await planVodReplication(output, async (key) => tree[key]);
  assert.deepEqual(
    new Set(plan.objects),
    new Set([
      "video/version1/init.mp4",
      "video/version1/segment.m4s",
      "video/version1/audio.aac",
      output.thumbnailKey,
    ]),
  );
  assert.equal(plan.playlists.at(-1).key, output.masterKey);
  await assert.rejects(
    planVodReplication(output, async (key) =>
      key === output.masterKey ? "#EXTM3U\n../../escape.ts" : tree[key],
    ),
  );
  await assert.rejects(
    planVodReplication(output, async (key) =>
      (tree[key] || "").replace("#EXT-X-ENDLIST", ""),
    ),
  );
});

test("worker never marks partial replicas READY and publishes master only after all data", async () => {
  const oldCopy = GcsReplicaStorage.prototype.copy,
    oldPlaylist = GcsReplicaStorage.prototype.playlist;
  let writes = [],
    failure = true,
    terminal;
  GcsReplicaStorage.prototype.copy = async (_client, _bucket, key) => {
    writes.push(key);
    if (failure) throw new Error("copy interrupted");
  };
  GcsReplicaStorage.prototype.playlist = async (_bucket, key) => {
    writes.push(key);
  };
  const db = {
    videoReplica: {
      count: async () => 1,
      updateMany: async ({ data }) => {
        terminal = data;
        return { count: 1 };
      },
    },
  };
  const source = {
    locations: {
      resolve: async () => ({
        driver: "s3",
        bucket: "source",
        region: "ap-northeast-1",
      }),
    },
    text: async (_location, key) => tree[key],
  };
  const worker = new VideoReplicationWorker(db, source, {});
  const replica = {
    id: "replica",
    jobId: "version1",
    output,
    destinationBucket: "replica",
    attempts: 0,
  };
  try {
    await worker.replicate(replica, "owner");
    assert.equal(terminal.status, "FAILED");
    assert.equal(
      writes.some((key) => key.endsWith(".m3u8")),
      false,
    );
    failure = false;
    writes = [];
    await worker.replicate(replica, "owner");
    assert.equal(terminal.status, "READY");
    assert.equal(terminal.objectCount, 7);
    assert.equal(writes.at(-1), output.masterKey);
    assert.equal(
      writes.slice(0, 4).some((key) => key.endsWith(".m3u8")),
      false,
    );
    assert.equal(terminal.leaseOwner, null);
  } finally {
    GcsReplicaStorage.prototype.copy = oldCopy;
    GcsReplicaStorage.prototype.playlist = oldPlaylist;
  }
});
