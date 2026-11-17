const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMeetingFixture } = require("../meeting-fixture.cjs");
const {
  StorageReplicationWorker,
} = require("../../dist/modules/video-processing/storage-replication.worker");
const {
  GcsReplicaStorage,
} = require("../../dist/modules/video-processing/gcs-replica-storage");
const { locationId } = require("../../dist/modules/files/storage-target");
const {
  RecordingSourceService,
} = require("../../dist/modules/class-recordings/recording-source.service");
const {
  RecordingPlaybackService,
} = require("../../dist/modules/class-recordings/recording-playback.service");

test(
  "raw/live discovery, lease takeover and atomic snapshots persist in SQL; status requires ADMIN",
  { timeout: 120000 },
  async () => {
    const f = await createMeetingFixture();
    const oldCopy = GcsReplicaStorage.prototype.copy;
    try {
      const db = f.prisma,
        owner = await f.account("Replica owner"),
        admin = await f.account("Replica admin", "ADMIN");
      const group = await db.group.create({
        data: { name: "Replica group", ownerId: owner.id },
      });
      const target = {
          driver: "s3",
          bucket: "test-source",
          region: "ap-northeast-1",
        },
        location = locationId(target);
      await db.storageLocation.create({
        data: { id: location, driver: "s3", config: target },
      });
      const file = await db.libraryFile.create({
        data: {
          groupId: group.id,
          createdBy: owner.id,
          name: "Original.pdf",
          objectKey: "uploads/" + randomUUID(),
          size: 25n,
          mimeType: "application/pdf",
          source: "DOCUMENT",
          status: "AVAILABLE",
          storageLocationId: location,
        },
      });
      const config = { video: { replication: { bucket: "test-replica" } } };
      const storage = { locations: { resolve: async () => target } };
      const a = new StorageReplicationWorker(db, storage, config),
        b = new StorageReplicationWorker(db, storage, config);
      await Promise.all([a.discover(), b.discover()]);
      assert.equal(await db.storageReplica.count(), 1);
      let claims = 0;
      const replicate = a.replicate.bind(a);
      a.replicate = b.replicate = async () => {
        claims++;
      };
      await Promise.all([a.tick(), b.tick()]);
      assert.equal(claims, 1);
      const raw = await db.storageReplica.findFirst();
      assert.equal(raw.status, "COPYING");
      await db.storageReplica.update({
        where: { id: raw.id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      GcsReplicaStorage.prototype.copy = async () => {};
      a.replicate = replicate;
      await a.tick();
      const done = await db.storageReplica.findUnique({
        where: { id: raw.id },
      });
      assert.equal(done.status, "READY");
      assert.equal(done.completed, true);
      assert.equal(done.snapshot.key, `replicas/raw/${file.id}/object`);
      assert.equal(
        (await f.api(owner, "GET", `/internal/assets/${file.id}/replicas`))
          .status,
        403,
      );
      const status = await f.api(
        admin,
        "GET",
        `/internal/assets/${file.id}/replicas`,
      );
      assert.equal(status.status, 200);
      assert.equal(status.body.storageReplicas[0].completed, true);

      const session = await db.classSession.create({
        data: {
          kind: "GROUP",
          groupId: group.id,
          createdById: owner.id,
          title: "Live",
          joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
          status: "LIVE",
          scheduledAt: new Date(),
          startedAt: new Date(),
        },
      });
      const recording = await db.classRecording.create({
        data: {
          id: randomUUID(),
          sessionId: session.id,
          recorderId: owner.id,
          provider: "IVS",
          storageLocationId: location,
          recordingPrefix: "ivs/session",
        },
      });
      let ended = false;
      const tree = () => ({
        "ivs/session/master.m3u8":
          "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nv.m3u8\n",
        "ivs/session/v.m3u8":
          "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ns.ts\n" +
          (ended ? "#EXT-X-ENDLIST\n" : ""),
      });
      storage.list = async () => new Set(Object.keys(tree()));
      storage.text = async (_, key) => tree()[key];
      await a.tick();
      const live = await db.storageReplica.findFirst({
        where: { kind: "LIVE_DVR" },
      });
      assert.equal(live.assetId, recording.id);
      assert.equal(live.status, "READY");
      assert.equal(live.readyThroughSeconds, 4);
      assert.equal(live.completed, false);
      assert.ok(live.snapshot.playlists["ivs/session/master.m3u8"]);
      assert.equal(
        live.snapshot.destinationPrefix,
        `replicas/live/${recording.id}`,
      );
      const playback = new RecordingSourceService(
        db,
        f.app.get(RecordingPlaybackService),
        {},
        {},
        {
          gcsSignedObjectFactory: async () => (key) =>
            `https://replica.example/${key}?signed=1`,
        },
        {
          list: async () => {
            throw Error("primary unavailable");
          },
        },
        {
          auth: { accessTokenSecret: "fixture", cookie: { secure: false } },
          video: { gcsDelivery: { bucket: "test-replica" } },
        },
      );
      playback.healthy = async () => true;
      const resolved = await playback.resolve(owner.id, recording.id, {
        mode: "LIVE_DVR",
        positionSeconds: 1,
      });
      assert.equal(resolved.sourceId, "gcs");
      const playlist = await playback.playlist(
        recording.id,
        recording.id,
        "gcs",
        ["v.m3u8"],
        resolved.deliveryCookies[0].value,
      );
      assert.match(playlist, new RegExp(`replicas/live/${recording.id}/s.ts`));
      ended = true;
      await db.storageReplica.update({
        where: { id: live.id },
        data: { nextRunAt: new Date(0) },
      });
      await a.tick();
      assert.equal(
        (await db.storageReplica.findUnique({ where: { id: live.id } }))
          .completed,
        true,
      );
      assert.equal(
        (
          await f.api(
            owner,
            "GET",
            `/internal/assets/${recording.id}/replicas/live`,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await f.api(
            admin,
            "GET",
            `/internal/assets/${recording.id}/replicas/live`,
          )
        ).body.replicas[0].readyThroughSeconds,
        4,
      );
      // A SAVED recording can outlive its deleted library file. Discovery must
      // exclude it and retire legacy retry rows, including exhausted attempts.
      await db.libraryFile.update({
        where: { id: file.id },
        data: { status: "DELETED", deletedAt: new Date() },
      });
      const removedRecording = await db.classRecording.create({
        data: {
          id: randomUUID(),
          sessionId: session.id,
          recorderId: owner.id,
          provider: "IVS",
          status: "SAVED",
          fileId: file.id,
          storageLocationId: location,
          recordingPrefix: "ivs/removed",
        },
      });
      await a.discover();
      assert.equal(
        await db.storageReplica.count({
          where: { assetId: removedRecording.id },
        }),
        0,
      );
      const stale = await db.storageReplica.create({
        data: {
          kind: "LIVE_DVR",
          assetId: removedRecording.id,
          destinationBucket: "test-replica",
          source: { storageLocationId: location, prefix: "ivs/removed" },
          status: "FAILED",
          attempts: 8,
          errorCode: "LEASE_LOST",
        },
      });
      const failedRecording = await db.classRecording.create({
        data: {
          id: randomUUID(),
          sessionId: session.id,
          recorderId: owner.id,
          provider: "IVS",
          status: "FAILED",
          storageLocationId: location,
          recordingPrefix: "ivs/failed",
        },
      });
      const leased = await db.storageReplica.create({
        data: {
          kind: "LIVE_DVR",
          assetId: failedRecording.id,
          destinationBucket: "test-replica",
          source: { storageLocationId: location, prefix: "ivs/failed" },
          status: "COPYING",
          leaseOwner: randomUUID(),
          leaseUntil: new Date(Date.now() + 60000),
        },
      });
      await a.discover();
      const retired = await db.storageReplica.findUnique({
        where: { id: stale.id },
      });
      assert.equal(retired.completed, true);
      assert.equal(retired.status, "FAILED");
      assert.equal(retired.errorCode, "REPLICA_SOURCE_INVALID");
      assert.equal(retired.attempts, 8);
      assert.equal(
        (await db.storageReplica.findUnique({ where: { id: leased.id } }))
          .completed,
        false,
      );
      await db.storageReplica.update({
        where: { id: leased.id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      await a.tick();
      assert.equal(
        (await db.storageReplica.findUnique({ where: { id: leased.id } }))
          .completed,
        true,
      );
      assert.equal(
        (await db.storageReplica.findUnique({ where: { id: live.id } })).status,
        "READY",
      );
    } finally {
      GcsReplicaStorage.prototype.copy = oldCopy;
      await f.cleanup();
    }
  },
);
