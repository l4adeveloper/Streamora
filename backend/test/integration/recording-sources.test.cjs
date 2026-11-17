const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMeetingFixture } = require("../meeting-fixture.cjs");
const {
  RecordingSourceService,
} = require("../../dist/modules/class-recordings/recording-source.service");
const {
  VideoDelivery,
} = require("../../dist/modules/video-processing/video-delivery");
const {
  VideoStorage,
} = require("../../dist/modules/video-processing/video-storage");

test(
  "VOD resolver selects only complete current replicas, reauthorizes grants and isolates internal metadata",
  { timeout: 120000 },
  async () => {
    const f = await createMeetingFixture();
    try {
      const owner = await f.account("Source owner"),
        viewer = await f.account("Source viewer"),
        outsider = await f.account("Outsider"),
        admin = await f.account("Operator", "ADMIN");
      const db = f.prisma;
      const group = await db.group.create({
        data: { name: "Sources", ownerId: owner.id },
      });
      await db.groupMember.create({
        data: { groupId: group.id, userId: viewer.id, role: "VIEWER" },
      });
      const session = await db.classSession.create({
        data: {
          kind: "GROUP",
          groupId: group.id,
          createdById: owner.id,
          title: "Video",
          joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
          status: "ENDED",
          scheduledAt: new Date(),
          startedAt: new Date(),
          endedAt: new Date(),
        },
      });
      const file = await db.libraryFile.create({
        data: {
          groupId: group.id,
          sessionId: session.id,
          createdBy: owner.id,
          name: "Video.mp4",
          objectKey: `source/${randomUUID()}`,
          size: 10n,
          mimeType: "video/mp4",
          source: "DOCUMENT",
          status: "AVAILABLE",
        },
      });
      const recording = await db.classRecording.create({
        data: {
          id: randomUUID(),
          sessionId: session.id,
          recorderId: owner.id,
          fileId: file.id,
          status: "SAVED",
        },
      });
      const output = {
        storageLocationId: "a".repeat(64),
        prefix: `groups/${group.id}/videos/${file.id}/${randomUUID()}`,
        duration: 120,
        renditions: [],
      };
      output.masterKey = output.prefix + "/master.m3u8";
      output.thumbnailKey = output.prefix + "/thumb.jpg";
      output.renditions.push({
        id: "720p",
        width: 1280,
        height: 720,
        bitrate: 3000000,
        codecs: "avc1",
        variantKey: output.prefix + "/720p.m3u8",
      });
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
      const replica = await db.videoReplica.create({
        data: {
          fileId: file.id,
          jobId: job.id,
          destinationBucket: "replica-test",
          output,
          status: "COPYING",
        },
      });
      Object.assign(f.config.video, {
        mode: "aws",
        region: "ap-northeast-1",
        outputBucket: "source-test",
        cloudFrontKeyPairId: "KTESTKEY123",
        gcsDelivery: {
          bucket: "replica-test",
          domain: "replica.example",
          keyName: "v2",
          signingSecretId: "test-only",
        },
      });
      const sources = f.app.get(RecordingSourceService),
        delivery = f.app.get(VideoDelivery),
        storage = f.app.get(VideoStorage);
      delivery.signedObjectFactory = async () => (key) =>
        `https://primary.example/${key}?Signature=primary`;
      delivery.gcsSignedObjectFactory = async () => (key) =>
        `https://replica.example/${key}?Signature=replica&KeyName=v2`;
      storage.locations.resolve = async () => ({
        driver: "s3",
        region: "ap-northeast-1",
        bucket: "source-test",
      });
      storage.text = async () =>
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\n720p.m3u8\n";
      sources.gcs.text = async () =>
        "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment-1.ts\n#EXT-X-ENDLIST\n";
      const unhealthy = new Set();
      sources.healthy = async (candidate) => !unhealthy.has(candidate.id);
      const path = `/recordings/${recording.id}/playback`;
      const detail = await f.api(viewer, "GET", `/recordings/${recording.id}`);
      assert.equal(detail.status, 200);
      assert.equal(
        detail.body.playbackPath,
        `/api/v1/recordings/${recording.id}/playback`,
      );
      assert.equal(detail.body.renditions[0].height, 720);
      const resolve = (actor = viewer, body = { mode: "VOD" }) =>
        f.api(actor, "POST", path, body);
      assert.equal((await resolve(outsider)).status, 403);
      assert.equal((await resolve(viewer, { mode: "OTHER" })).status, 400);
      assert.equal((await resolve(viewer, { mode: "LIVE_DVR" })).status, 409);
      assert.equal(
        (await resolve(viewer, { mode: "VOD", positionSeconds: 121 })).status,
        400,
      );
      let result = await resolve();
      assert.equal(result.status, 200);
      assert.equal(result.body.sourceId, "cloudfront");
      assert.equal(result.body.fallbackAvailable, false);
      assert.equal(
        (await resolve(viewer, { mode: "VOD", failedSourceId: "cloudfront" }))
          .body.sourceId,
        "cloudfront",
      );
      await db.videoReplica.update({
        where: { id: replica.id },
        data: { status: "READY", objectCount: 4, lastSyncedAt: new Date() },
      });
      result = await resolve();
      assert.equal(result.body.fallbackAvailable, true);
      const response = await fetch(f.base + path, {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3000",
          Authorization: `Bearer ${viewer.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "VOD",
          failedSourceId: "cloudfront",
          positionSeconds: 42,
        }),
      });
      const fallback = await response.json();
      assert.equal(response.status, 200);
      assert.equal(fallback.sourceId, "gcs");
      assert.equal(
        (await resolve(viewer, { mode: "VOD", preferredSourceId: "gcs" })).body
          .sourceId,
        "gcs",
      );
      const cookie = response.headers.get("set-cookie").split(";")[0];
      const mediaUrl = f.base.replace(/\/api\/v1$/, "") + fallback.manifestUrl;
      assert.equal((await fetch(mediaUrl)).status, 403);
      const tamperedCookie =
        cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a");
      assert.equal(
        (await fetch(mediaUrl, { headers: { Cookie: tamperedCookie } })).status,
        403,
      );
      const expiredToken = sources.grant({
        userId: viewer.id,
        recordingId: recording.id,
        jobId: job.id,
        sourceId: "gcs",
        expires: Math.floor(Date.now() / 1000) - 1,
      });
      assert.equal(
        (
          await fetch(mediaUrl, {
            headers: {
              Cookie: "recording_grant=" + encodeURIComponent(expiredToken),
            },
          })
        ).status,
        403,
      );
      const playlist = await fetch(mediaUrl, { headers: { Cookie: cookie } });
      assert.equal(playlist.status, 200);
      assert.equal(playlist.headers.get("cache-control"), "private, no-store");
      assert.match(
        await playlist.text(),
        /https:\/\/replica\.example\/.*segment-1\.ts\?Signature=replica&KeyName=v2/,
      );
      assert.equal(
        (
          await fetch(mediaUrl.replace("/gcs/", "/cloudfront/"), {
            headers: { Cookie: cookie },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(
            mediaUrl.replace("master.m3u8", "%252e%252e%252foutside.m3u8"),
            { headers: { Cookie: cookie } },
          )
        ).status,
        403,
      );
      const thumbnail = await f.api(
        viewer,
        "GET",
        `/recordings/${recording.id}/thumbnail`,
      );
      assert.equal(thumbnail.status, 200);
      assert.match(thumbnail.body.url, /thumb\.jpg\?Signature=/);
      const internal = `/internal/assets/${file.id}/replicas`;
      assert.equal((await f.api(viewer, "GET", internal)).status, 403);
      assert.equal((await f.api(owner, "GET", internal)).status, 403);
      assert.equal(
        (await f.api(admin, "GET", internal)).body.replicas[0].current,
        true,
      );
      unhealthy.add("cloudfront");
      assert.equal((await resolve()).body.sourceId, "gcs");
      unhealthy.add("gcs");
      assert.equal((await resolve()).status, 503);
      unhealthy.clear();
      await db.videoReplica.update({
        where: { id: replica.id },
        data: {
          output: { ...output, masterKey: output.prefix + "/different.m3u8" },
        },
      });
      assert.equal((await resolve()).body.fallbackAvailable, false);
      assert.equal(
        (await fetch(mediaUrl, { headers: { Cookie: cookie } })).status,
        503,
      );
      await db.videoReplica.update({
        where: { id: replica.id },
        data: { output },
      });
      await db.groupMember.delete({
        where: { userId_groupId: { userId: viewer.id, groupId: group.id } },
      });
      assert.equal((await resolve()).status, 403);
      assert.equal(
        (await fetch(mediaUrl, { headers: { Cookie: cookie } })).status,
        403,
      );
      await db.libraryFile.update({
        where: { id: file.id },
        data: { isPublished: false },
      });
      assert.equal((await resolve(outsider)).status, 403);
    } finally {
      await f.cleanup();
    }
  },
);
