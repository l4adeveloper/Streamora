const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMeetingFixture } = require("../meeting-fixture.cjs");
const { createVideoDynamoFixture } = require("../video-dynamodb-fixture.cjs");
const {
  VideoCloudBridge,
} = require("../../dist/modules/video-processing/video-cloud-bridge");
const {
  VideoProcessingService,
  enqueueVideo,
} = require("../../dist/modules/video-processing/video-processing.service");
const {
  StorageLocationsService,
} = require("../../dist/modules/files/storage-locations.service");
const { locationId } = require("../../dist/modules/files/storage-target");

test("AWS handoff survives a delivery failure; DynamoDB owns status, retry and terminal state while SQL preserves file pins", async () => {
  let f, cloud, service, previousBridge;
  try {
    f = await createMeetingFixture();
    cloud = await createVideoDynamoFixture();
    const db = f.prisma,
      owner = await f.account("Video owner"),
      outsider = await f.account("Outside");
    const group = await db.group.create({
      data: { name: "Cloud pipeline", ownerId: owner.id },
    });
    const sourceLocation = locationId(cloud.target);
    await db.storageLocation.create({
      data: { id: sourceLocation, driver: "s3", config: cloud.target },
    });
    const file = await db.libraryFile.create({
      data: {
        groupId: group.id,
        createdBy: owner.id,
        name: "Cloud.mp4",
        objectKey: cloud.source.key,
        size: 12n,
        mimeType: "video/mp4",
        source: "DOCUMENT",
        status: "AVAILABLE",
        storageLocationId: sourceLocation,
      },
    });
    const jobId = await db.$transaction((tx) =>
      enqueueVideo(tx, file, "mediaconvert"),
    );
    const bridge = new VideoCloudBridge(
      db,
      f.app.get(StorageLocationsService),
      {
        ...f.config,
        files: { ...f.config.files, bucket: cloud.target.bucket },
        video: cloud.video,
      },
    );
    bridge.store.close(); // Replace the unused AWS client before any I/O.
    bridge.store = cloud.store;
    service = f.app.get(VideoProcessingService);
    previousBridge = service.cloud;
    service.cloud = bridge;
    await db.videoJob.update({
      where: { id: jobId },
      data: {
        state: "PROCESSING",
        leaseOwner: randomUUID(),
        leaseUntil: new Date(Date.now() + 30000),
      },
    });
    await bridge.deliver(file.id);
    assert.equal(
      await cloud.store.job(jobId),
      null,
      "cutover must respect an active SQL worker lease",
    );
    await db.videoJob.update({
      where: { id: jobId },
      data: {
        state: "QUEUED",
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    const ensure = cloud.store.ensure.bind(cloud.store);
    cloud.store.ensure = async () => {
      throw new Error("simulated handoff interruption");
    };
    await service.queueCommitted(file.id);
    assert.equal(
      (await db.videoJob.findUnique({ where: { id: jobId } })).state,
      "QUEUED",
    );
    assert.equal(await db.fileUsage.count({ where: { fileId: file.id } }), 1);
    assert.equal(await cloud.store.job(jobId), null);
    cloud.store.ensure = ensure;
    await bridge.tick();
    assert.equal((await cloud.store.job(jobId)).state, "QUEUED");
    const claim = await cloud.store.claim(randomUUID(), jobId);
    await cloud.store.fail(claim, "ENCODE_FAILED");
    assert.equal((await service.snapshot(file.id)).status, "FAILED");
    assert.equal(
      (await db.videoJob.findUnique({ where: { id: jobId } })).state,
      "QUEUED",
      "SQL handoff state must not mask the DynamoDB result",
    );
    await assert.rejects(
      service.retry(outsider.id, file.id, "retry-key"),
      (error) => error.getStatus() === 403,
    );
    const retried = await service.retry(owner.id, file.id, "retry-key");
    const replayed = await service.retry(owner.id, file.id, "retry-key");
    assert.equal(retried.jobId, replayed.jobId);
    assert.notEqual(retried.jobId, jobId);
    assert.equal(await db.videoJob.count({ where: { fileId: file.id } }), 2);
    assert.equal(await db.fileUsage.count({ where: { fileId: file.id } }), 1);
    const next = await cloud.store.claim(randomUUID(), retried.jobId);
    const location = await cloud.store.outputLocation(),
      prefix = `groups/${group.id}/videos/${file.id}/${next.id}/1`;
    await cloud.store.publish(next, {
      storageLocationId: location,
      prefix,
      masterKey: prefix + "/hls/master.m3u8",
      duration: 2,
      renditions: [],
    });
    assert.equal((await service.snapshot(file.id)).status, "READY");
    await bridge.deliver(file.id);
    assert.equal(
      (await db.videoJob.findUnique({ where: { id: next.id } })).state,
      "READY",
    );
    assert.equal(await db.fileUsage.count({ where: { fileId: file.id } }), 0);
    assert.equal(
      (await db.videoAsset.findUnique({ where: { fileId: file.id } }))
        .publishedJobId,
      next.id,
    );
    await bridge.deleted(file.id);
    assert.equal((await cloud.store.asset(file.id)).deleted, true);
  } finally {
    if (service) service.cloud = previousBridge;
    await cloud?.cleanup();
    await f?.cleanup();
  }
});
