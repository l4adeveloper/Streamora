const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const { createReadStream } = require("node:fs");
const { mkdir, readFile } = require("node:fs/promises");
const { join, basename } = require("node:path");
const { createMeetingFixture } = require("../meeting-fixture.cjs");
const {
  ClassRecordingsService,
} = require("../../dist/modules/class-recordings/class-recordings.service");
const {
  ClassSessionAccessService,
} = require("../../dist/modules/class-sessions/class-session-access.service");
const {
  ClassSessionsService,
} = require("../../dist/modules/class-sessions/class-sessions.service");
const {
  CloudRecordingWorker,
} = require("../../dist/modules/class-recordings/cloud-recording.worker");
const {
  FileStorageService,
} = require("../../dist/modules/files/file-storage.service");
const {
  VideoProcessingService,
} = require("../../dist/modules/video-processing/video-processing.service");
const {
  VideoWorker,
} = require("../../dist/modules/video-processing/video-worker");
const {
  recordingKey,
} = require("../../dist/modules/class-recordings/recording-export");
const {
  runProcess,
  probe,
} = require("../../dist/modules/video-processing/video-probe");
let f, db, owner, viewer, host, group, storage, processing, directory;
let finalized = false,
  mode = "ACTIVE",
  starts = 0,
  stops = 0,
  exportCount = 0;
let cloud, recordings;
const prefix = "stage/composition/destination/composite";
const stageArn = "arn:aws:ivs:ap-northeast-1:123456789012:stage/test";
const noKey = () => Object.assign(new Error("missing"), { name: "NoSuchKey" });
const ivs = {
  findRecording: async () => null,
  config: {
    ivs: {
      region: "ap-northeast-1",
      recording: { storageArn: "storage", encoderArn: "encoder" },
    },
  },
  recordingBucket: async () => "recording-test",
  startRecording: async () => {
    starts++;
    return {
      arn: "composition",
      destinations: [{ detail: { s3: { recordingPrefix: prefix } } }],
    };
  },
  recording: async () => (mode === "GONE" ? null : { state: mode }),
  stopRecording: async () => {
    stops++;
    mode = "STOPPED";
  },
};
let fakeStorage;
before(
  async () => {
    f = await createMeetingFixture();
    db = f.prisma;
    owner = await f.account("Owner");
    viewer = await f.account("Viewer");
    host = await f.account("Host");
    group = await db.group.create({
      data: { name: "Cloud recordings", ownerId: owner.id },
    });
    for (const [user, role] of [
      [viewer, "VIEWER"],
      [host, "HOST"],
    ])
      await db.groupMember.create({
        data: { groupId: group.id, userId: user.id, role },
      });
    storage = f.app.get(FileStorageService);
    processing = f.app.get(VideoProcessingService);
    f.config.files.publicBaseUrl = f.base.replace("/api/v1", "");
    f.config.video.ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
    f.config.video.ffprobePath = require("@ffprobe-installer/ffprobe").path;
    directory = join(f.config.files.localDirectory, "ivs-input");
    await mkdir(directory, { recursive: true });
    await runProcess(
      f.config.video.ffmpegPath,
      [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=640x360:r=6:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        "-f",
        "hls",
        "-hls_time",
        "1",
        "-hls_segment_type",
        "fmp4",
        "-hls_playlist_type",
        "vod",
        "playlist.m3u8",
      ],
      { cwd: directory },
    );
    fakeStorage = {
      locations: {
        id: storage.locations.id,
        target: { driver: "s3", region: "ap-northeast-1" },
        resolve: async () => ({ driver: "s3", bucket: "recording-test" }),
      },
      read: async (key) => {
        if (key.endsWith("/events/recording-ended.json")) {
          if (!finalized) throw noKey();
          return Readable.from([
            JSON.stringify({
              stage_arn: stageArn,
              recording_status: "RECORDING_ENDED",
              media: {
                hls: {
                  duration_ms: 2000,
                  path: "media/hls",
                  playlist: "multivariant.m3u8",
                },
              },
            }),
          ]);
        }
        if (key.endsWith("/events/recording-failed.json")) throw noKey();
        if (key.endsWith("multivariant.m3u8"))
          return Readable.from([
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\nplaylist.m3u8\n",
          ]);
        return createReadStream(join(directory, basename(key)));
      },
      writeFile: async (path, key) => {
        exportCount++;
        await storage.importLocalFile(path, key, storage.locations.id);
      },
    };
    cloud = new CloudRecordingWorker(
      db,
      ivs,
      fakeStorage,
      processing,
      f.config,
    );
    recordings = new ClassRecordingsService(
      db,
      f.app.get(ClassSessionAccessService),
      { ivs, revoke: async () => {} },
      fakeStorage,
      { wake() {} },
    );
  },
  { timeout: 120000 },
);
after(async () => {
  if (f) await f.cleanup();
});
async function session() {
  const row = await db.classSession.create({
    data: {
      kind: "GROUP",
      groupId: group.id,
      createdById: owner.id,
      title: "Lesson",
      joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
      status: "LIVE",
      scheduledAt: new Date(),
      startedAt: new Date(),
    },
  });
  await db.classMediaRoom.create({
    data: { sessionId: row.id, state: "READY", stageArn },
  });
  const visit = await db.classParticipation.create({
    data: { sessionId: row.id, userId: owner.id },
  });
  return { row, visit };
}
async function tick(id) {
  await db.classRecording.update({
    where: { id },
    data: { nextCheckAt: new Date(0) },
  });
  await cloud.tick(id);
  return db.classRecording.findUniqueOrThrow({ where: { id } });
}

test(
  "IVS recording survives a closed browser, finalizes after restart, and only then queues qualities and captions",
  async () => {
    const { row: lesson, visit } = await session();
    const { recording } = await recordings.start(owner.id, lesson.id, visit.id);
    const again = await recordings.start(owner.id, lesson.id, visit.id);
    assert.equal(again.recording.id, recording.id);
    assert.equal(await db.videoJob.count(), 0);
    assert.equal(await db.videoTranscript.count(), 0);
    await tick(recording.id);
    assert.equal(starts, 1);
    await db.classParticipation.update({
      where: { id: visit.id },
      data: { leftAt: new Date(), leaveReason: "DISCONNECTED" },
    });
    await db.classRecording.update({
      where: { id: recording.id },
      data: { lastSeenAt: new Date(0) },
    });
    assert.equal(
      (await recordings.state(owner.id, lesson.id)).recording.status,
      "RECORDING",
    );
    await tick(recording.id);
    assert.equal(stops, 0);
    assert.equal(await db.videoJob.count(), 0);
    await assert.rejects(
      recordings.complete(owner.id, lesson.id, recording.id, randomUUID()),
      (error) =>
        error.getResponse().error.code === "RECORDING_MANAGED_BY_SERVER",
    );
    await assert.rejects(
      recordings.fail(owner.id, lesson.id, recording.id),
      (error) =>
        error.getResponse().error.code === "RECORDING_MANAGED_BY_SERVER",
    );
    await assert.rejects(
      recordings.stop(viewer.id, lesson.id, recording.id),
      (error) => error.getStatus() === 403,
    );
    await recordings.stop(host.id, lesson.id, recording.id);
    let saved = await tick(recording.id);
    assert.equal(saved.status, "SAVING");
    assert.ok(
      saved.nextCheckAt.getTime() - Date.now() <= 3000,
      "A requested stop must be checked again within 3 seconds",
    );
    assert.equal(stops, 1);
    assert.equal(exportCount, 0);
    assert.equal(await db.videoJob.count(), 0);
    finalized = true;
    mode = "GONE"; // IVS has already removed its composition resource.
    cloud = new CloudRecordingWorker(
      db,
      ivs,
      fakeStorage,
      processing,
      f.config,
    );
    saved = await tick(recording.id);
    assert.equal(saved.status, "SAVED", JSON.stringify(saved));
    assert.ok(saved.fileId);
    assert.equal(
      await db.videoJob.count({ where: { fileId: saved.fileId } }),
      1,
    );
    assert.equal(
      await db.videoTranscript.count({
        where: { fileId: saved.fileId, transcriptStatus: "PENDING" },
      }),
      1,
    );
    const file = await db.libraryFile.findUniqueOrThrow({
      where: { id: saved.fileId },
    });
    assert.equal(file.source, "CLOUD_RECORDING");
    const input = await storage.locations.resolve(file.storageLocationId);
    const metadata = await probe(
      f.config.video.ffprobePath,
      join(input.directory, file.objectKey),
    );
    assert.equal(metadata.width, 640);
    assert.equal(metadata.audio, true);
    await tick(recording.id);
    assert.equal(exportCount, 1); // Repeated checks cannot duplicate jobs/files.
    const worker = f.app.get(VideoWorker);
    const job = await db.videoJob.findFirstOrThrow({
      where: { fileId: saved.fileId },
    });
    assert.equal(await worker.once(job.id), true);
    assert.equal((await processing.snapshot(saved.fileId)).status, "READY");
  },
  { timeout: 120000 },
);

test(
  "manual quality processing supports old videos, deduplicates running jobs, and preserves published output during rebuild",
  async () => {
    const key = "legacy/video.mp4";
    const finished = await db.libraryFile.findFirstOrThrow({
      where: { source: "CLOUD_RECORDING" },
    });
    const file = await db.libraryFile.create({
      data: {
        groupId: group.id,
        createdBy: owner.id,
        name: "Old video.mp4",
        source: "DOCUMENT",
        objectKey: key,
        storageLocationId: storage.locations.id,
        size: 100n,
        mimeType: "video/mp4",
        status: "AVAILABLE",
      },
    });
    const location = await storage.locations.resolve(
      finished.storageLocationId,
    );
    await storage.importLocalFile(
      join(location.directory, finished.objectKey),
      key,
      storage.locations.id,
    );
    const path = "/files/" + file.id + "/processing";
    assert.equal(
      (await f.api(viewer, "POST", path, {}, randomUUID())).status,
      403,
    );
    assert.equal((await f.api(owner, "POST", path, {})).status, 400);
    const requestKey = randomUUID();
    const a = await f.api(owner, "POST", path, {}, requestKey);
    assert.equal(a.status, 202, JSON.stringify(a.body));
    const b = await f.api(owner, "POST", path, {}, requestKey);
    assert.deepEqual(a.body, b.body);
    const c = await f.api(owner, "POST", path, {}, randomUUID());
    assert.equal(c.body.jobId, a.body.jobId);
    assert.equal(await db.videoJob.count({ where: { fileId: file.id } }), 1);
    const worker = f.app.get(VideoWorker);
    await worker.once(a.body.jobId);
    let asset = await db.videoAsset.findUniqueOrThrow({
      where: { fileId: file.id },
    });
    assert.equal(asset.publishedJobId, a.body.jobId);
    const rebuild = await f.api(owner, "POST", path, {}, randomUUID());
    assert.equal(rebuild.status, 202);
    assert.notEqual(rebuild.body.jobId, a.body.jobId);
    asset = await db.videoAsset.findUniqueOrThrow({
      where: { fileId: file.id },
    });
    assert.equal(asset.publishedJobId, a.body.jobId);
    const claimed = await processing.claim(randomUUID(), rebuild.body.jobId);
    await processing.fail(claimed, "ENCODE_FAILED");
    assert.equal((await processing.snapshot(file.id)).renditions.length, 1);
    assert.equal(
      (await f.api(owner, "POST", path, {}, randomUUID())).status,
      202,
    );
  },
  { timeout: 120000 },
);

test("End stops recording, keeps the meeting live until saved, and survives a worker restart", async () => {
  const lesson = await db.classSession.create({
    data: {
      kind: "GROUP",
      groupId: group.id,
      createdById: owner.id,
      title: "Ended lesson",
      joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
      status: "LIVE",
      scheduledAt: new Date(),
      startedAt: new Date(),
    },
  });
  await db.classParticipation.create({
    data: { sessionId: lesson.id, userId: owner.id },
  });
  const active = await db.classRecording.create({
    data: {
      id: randomUUID(),
      provider: "IVS",
      sessionId: lesson.id,
      recorderId: owner.id,
      stageArn,
      compositionArn: "composition",
      recordingPrefix: `${prefix}/${randomUUID()}`,
      storageLocationId: storage.locations.id,
    },
  });
  const beforeEndStops = stops;
  const ended = await f.api(
    owner,
    "POST",
    `/sessions/${lesson.id}/end`,
    {},
    randomUUID(),
  );
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.session.status, "LIVE");
  assert.ok(ended.body.session.endRequestedAt);
  assert.equal(
    stops,
    beforeEndStops,
    "The API records the intent without holding a transaction for AWS",
  );
  assert.equal(
    await db.classParticipation.count({
      where: { sessionId: lesson.id, leftAt: null },
    }),
    1,
  );
  finalized = false;
  mode = "ACTIVE";
  const beforeStops = stops,
    beforeJobs = await db.videoJob.count();
  assert.equal((await tick(active.id)).status, "SAVING");
  assert.equal(stops, beforeStops + 1);
  assert.equal(await db.videoJob.count(), beforeJobs);
  const sessions = f.app.get(ClassSessionsService);
  assert.equal(
    (await sessions.finishRequestedEnd(lesson.id)).session.status,
    "LIVE",
  );
  assert.equal(
    await db.classSessionEndEvent.count({ where: { sessionId: lesson.id } }),
    0,
  );
  await assert.rejects(
    recordings.start(owner.id, lesson.id, randomUUID()),
    (error) => error.getResponse().error.code === "SESSION_ENDING",
  );
  cloud = new CloudRecordingWorker(db, ivs, fakeStorage, processing, f.config);
  finalized = true;
  assert.equal((await tick(active.id)).status, "SAVED");
  await sessions.finishRequestedEnd(lesson.id);
  assert.equal(
    (await db.classSession.findUniqueOrThrow({ where: { id: lesson.id } }))
      .status,
    "ENDED",
  );
  assert.equal(
    await db.classParticipation.count({
      where: { sessionId: lesson.id, leftAt: null },
    }),
    0,
  );
  assert.equal(
    await db.classSessionEndEvent.count({ where: { sessionId: lesson.id } }),
    1,
  );
  await sessions.finishRequestedEnd(lesson.id);
  assert.equal(
    await db.classSessionEndEvent.count({ where: { sessionId: lesson.id } }),
    1,
  );
  const pending = await db.classRecording.create({
    data: {
      id: randomUUID(),
      provider: "IVS",
      sessionId: lesson.id,
      recorderId: owner.id,
      stageArn,
      storageLocationId: storage.locations.id,
    },
  });
  const beforeStarts = starts;
  assert.equal((await tick(pending.id)).status, "FAILED");
  assert.equal(starts, beforeStarts);
});

test("recording permission remains visible without cloud setup; entering or reading state never starts recording", async () => {
  const lesson = await db.classSession.create({
    data: {
      kind: "GROUP",
      groupId: group.id,
      createdById: owner.id,
      title: "Explicit recording",
      joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
      status: "LIVE",
      scheduledAt: new Date(),
      startedAt: new Date(),
    },
  });
  const visit = await db.classParticipation.create({
    data: { sessionId: lesson.id, userId: owner.id },
  });
  const state = await f.api(owner, "GET", `/sessions/${lesson.id}/recording`);
  assert.equal(state.status, 200);
  assert.equal(state.body.canRecord, true);
  assert.equal(state.body.recording, null);
  assert.equal(
    await db.classRecording.count({ where: { sessionId: lesson.id } }),
    0,
  );
  const start = await f.api(
    owner,
    "POST",
    `/sessions/${lesson.id}/recordings`,
    { participationId: visit.id },
  );
  assert.equal(
    start.status,
    503,
    "Only an explicit click attempts cloud recording and reports missing setup",
  );
  assert.equal(
    await db.classRecording.count({ where: { sessionId: lesson.id } }),
    0,
  );
});

test("recording paths cannot leave their S3 prefix or use remote URLs", () => {
  assert.equal(
    recordingKey(
      "recording",
      "recording/media/hls/index.m3u8",
      "high/playlist.m3u8",
    ),
    "recording/media/hls/high/playlist.m3u8",
  );
  for (const uri of [
    "../../../outside.ts",
    "https://evil.test/x",
    "file:///secret",
    "/etc/passwd",
    "%2e%2e/secret",
  ])
    assert.throws(() =>
      recordingKey("recording", "recording/media/index.m3u8", uri),
    );
});

test("stopped, failed and deleted compositions finish from S3 without repeating StopComposition", async () => {
  const lesson = await db.classSession.findFirstOrThrow({
    where: { title: "Lesson" },
  });
  const originalStop = ivs.stopRecording;
  const originalMode = mode;
  const originalFinalized = finalized;
  let stopAttempts = 0;
  ivs.stopRecording = async () => {
    stopAttempts++;
    throw Object.assign(new Error("already stopped"), {
      name: "ConflictException",
    });
  };
  finalized = true;
  try {
    for (const state of ["STOPPED", "FAILED", "GONE", "STOPPING"]) {
      mode = state;
      const row = await db.classRecording.create({
        data: {
          id: randomUUID(),
          sessionId: lesson.id,
          recorderId: owner.id,
          provider: "IVS",
          status: "SAVING",
          stoppedAt: new Date(),
          stageArn,
          compositionArn: `composition-${randomUUID()}`,
          recordingPrefix: `${prefix}/${randomUUID()}`,
          storageLocationId: storage.locations.id,
        },
      });
      if (state === "STOPPING") {
        const waiting = await tick(row.id);
        assert.equal(waiting.status, "SAVING");
        assert.equal(waiting.fileId, null);
        assert.ok(waiting.nextCheckAt.getTime() - Date.now() <= 3000);
        mode = "STOPPED";
      }
      const result = await tick(row.id);
      assert.equal(result.status, "SAVED", JSON.stringify(result));
      assert.ok(result.fileId);
      assert.equal(result.errorCode, null);
      assert.equal(
        await db.videoJob.count({ where: { fileId: result.fileId } }),
        1,
      );
      assert.equal(
        await db.videoTranscript.count({ where: { fileId: result.fileId } }),
        1,
      );
    }
    assert.equal(stopAttempts, 0);
  } finally {
    ivs.stopRecording = originalStop;
    mode = originalMode;
    finalized = originalFinalized;
  }
});

test("S3 failures preserve the error code and exact step, omit secrets, and recover on retry", async () => {
  const lesson = await db.classSession.findFirstOrThrow({
    where: { title: "Lesson" },
  });
  const row = await db.classRecording.create({
    data: {
      id: randomUUID(),
      sessionId: lesson.id,
      recorderId: owner.id,
      provider: "IVS",
      status: "SAVING",
      stoppedAt: new Date(),
      stageArn,
      compositionArn: `composition-${randomUUID()}`,
      recordingPrefix: `${prefix}/${randomUUID()}`,
      storageLocationId: storage.locations.id,
    },
  });
  const originalRead = fakeStorage.read,
    originalWrite = fakeStorage.writeFile;
  const previousMode = mode,
    previousFinalized = finalized;
  const worker = new CloudRecordingWorker(
    db,
    ivs,
    fakeStorage,
    processing,
    f.config,
  );
  const logs = [];
  worker.logger.warn = (line) => logs.push(JSON.parse(line));
  const denied = () => {
    throw Object.assign(new Error("secret-signed-url-must-not-appear"), {
      name: "AccessDenied",
    });
  };
  mode = "STOPPED";
  finalized = true;
  try {
    for (const step of ["read_s3_metadata", "upload_mp4"]) {
      fakeStorage.read = step === "read_s3_metadata" ? denied : originalRead;
      fakeStorage.writeFile = step === "upload_mp4" ? denied : originalWrite;
      await db.classRecording.update({
        where: { id: row.id },
        data: { nextCheckAt: new Date(0) },
      });
      await worker.tick(row.id);
      const pending = await db.classRecording.findUniqueOrThrow({
        where: { id: row.id },
      });
      assert.equal(pending.status, "SAVING");
      assert.equal(pending.errorCode, "AccessDenied");
      assert.equal(pending.fileId, null);
      assert.equal(logs.at(-1).step, step);
      assert.equal(logs.at(-1).code, "AccessDenied");
    }
    assert.ok(!JSON.stringify(logs).includes("secret-signed-url"));
    fakeStorage.read = originalRead;
    fakeStorage.writeFile = originalWrite;
    await db.classRecording.update({
      where: { id: row.id },
      data: { nextCheckAt: new Date(0) },
    });
    await worker.tick(row.id);
    const saved = await db.classRecording.findUniqueOrThrow({
      where: { id: row.id },
    });
    assert.equal(saved.status, "SAVED");
    assert.equal(saved.errorCode, null);
  } finally {
    fakeStorage.read = originalRead;
    fakeStorage.writeFile = originalWrite;
    mode = previousMode;
    finalized = previousFinalized;
  }
});
