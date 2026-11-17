const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMeetingFixture } = require("../meeting-fixture.cjs");
const {
  VideoReplicationWorker,
} = require("../../dist/modules/video-processing/video-replication.worker");

test(
  "replica discovery is idempotent and concurrent workers cannot claim one version twice",
  { timeout: 120000 },
  async () => {
    const f = await createMeetingFixture();
    try {
      const db = f.prisma,
        user = await f.account("Replica owner");
      const group = await db.group.create({
        data: { name: "Replica group", ownerId: user.id },
      });
      const file = await db.libraryFile.create({
        data: {
          groupId: group.id,
          createdBy: user.id,
          name: "Video",
          objectKey: `replica/${randomUUID()}`,
          size: 10n,
          mimeType: "video/mp4",
          source: "DOCUMENT",
          status: "AVAILABLE",
        },
      });
      const output = {
        storageLocationId: "a".repeat(64),
        prefix: "v/1",
        masterKey: "v/1/master.m3u8",
        renditions: [],
      };
      const job = await db.videoJob.create({
        data: {
          fileId: file.id,
          mode: "TRANSCODE",
          encoder: "mediaconvert",
          state: "READY",
          output,
        },
      });
      await db.videoAsset.create({
        data: {
          fileId: file.id,
          source: {},
          currentJobId: job.id,
          publishedJobId: job.id,
        },
      });
      const config = { video: { replication: { bucket: "streamora-test" } } };
      const a = new VideoReplicationWorker(db, {}, config),
        b = new VideoReplicationWorker(db, {}, config);
      await Promise.all([a.discover(), b.discover()]);
      assert.equal(await db.videoReplica.count(), 1);
      let copies = 0;
      const copy = async () => {
        copies++;
      };
      a.replicate = copy;
      b.replicate = copy;
      await Promise.all([a.tick(), b.tick()]);
      assert.equal(copies, 1);
      const replica = await db.videoReplica.findFirst();
      assert.equal(replica.status, "COPYING");
      assert.equal(replica.attempts, 1);
      await db.videoReplica.update({
        where: { id: replica.id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      await b.tick();
      assert.equal(copies, 2);
      assert.equal((await db.videoReplica.findFirst()).attempts, 2);
    } finally {
      await f.cleanup();
    }
  },
);
