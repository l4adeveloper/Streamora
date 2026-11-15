const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  mkdir,
  readFile,
  writeFile,
  unlink,
  stat,
} = require("node:fs/promises");
const { join } = require("node:path");
const { createMeetingFixture } = require("../meeting-fixture.cjs");
const {
  VideoWorker,
} = require("../../dist/modules/video-processing/video-worker");
const {
  VideoProcessingService,
  enqueueVideo,
} = require("../../dist/modules/video-processing/video-processing.service");
const { FilesService } = require("../../dist/modules/files/files.service");
const {
  FileStorageService,
} = require("../../dist/modules/files/file-storage.service");
const {
  probe,
  runProcess,
} = require("../../dist/modules/video-processing/video-probe");
let f, db, owner, viewer, outsider, group, worker, service, storage, clip;
before(
  async () => {
    f = await createMeetingFixture();
    db = f.prisma;
    owner = await f.account("Owner");
    viewer = await f.account("Viewer");
    outsider = await f.account("Outside");
    group = await db.group.create({
      data: { name: "Pipeline", ownerId: owner.id },
    });
    await db.groupMember.create({
      data: { groupId: group.id, userId: viewer.id, role: "VIEWER" },
    });
    f.config.files.publicBaseUrl = f.base.replace("/api/v1", "");
    f.config.video.ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
    f.config.video.ffprobePath = require("@ffprobe-installer/ffprobe").path;
    f.config.video.scratchDirectory = join(
      f.config.files.localDirectory,
      "scratch",
    );
    worker = f.app.get(VideoWorker);
    service = f.app.get(VideoProcessingService);
    storage = f.app.get(FileStorageService);
    clip = join(f.config.files.localDirectory, "clip.mp4");
    await runProcess(f.config.video.ffmpegPath, [
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=1920x1080:r=6:d=2",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      clip,
    ]);
  },
  { timeout: 120000 },
);
after(async () => {
  await f?.cleanup();
});
async function file(input = clip, extra = {}) {
  const key = `groups/${group.id}/uploads/${randomUUID()}`;
  const location = await storage.currentLocationId();
  await storage.importLocalFile(input, key, location);
  const row = await db.libraryFile.create({
    data: {
      groupId: group.id,
      createdBy: owner.id,
      name: "Clip.mp4",
      objectKey: key,
      size: BigInt((await stat(input)).size),
      mimeType: "video/mp4",
      source: "DOCUMENT",
      status: "AVAILABLE",
      storageLocationId: location,
      ...extra,
    },
  });
  const jobId = await db.$transaction((tx) => enqueueVideo(tx, row, "ffmpeg"));
  return { row, jobId };
}
test(
  "1080p real encode publishes three playable variants, truthful status, protected segments and recording API",
  async () => {
    const { row, jobId } = await file();
    assert.equal(
      (await f.api(viewer, "GET", `/files/${row.id}/processing`)).body.status,
      "QUEUED",
    );
    assert.equal(
      (await f.api(outsider, "GET", `/files/${row.id}/processing`)).status,
      403,
    );
    assert.equal(await worker.once(jobId), true);
    const job = await db.videoJob.findUnique({ where: { id: jobId } });
    assert.equal(job.state, "READY", job.errorCode);
    assert.deepEqual(
      job.output.renditions.map((r) => r.height),
      [1080, 720, 360],
    );
    assert.equal(await db.fileUsage.count({ where: { fileId: row.id } }), 0);
    const response = await fetch(`${f.base}/files/${row.id}/playback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewer.token}` },
    });
    assert.equal(response.status, 200);
    const manifest = await response.json();
    assert.equal(manifest.qualities.length, 3);
    assert.ok(!JSON.stringify(manifest).includes("deliveryCookies"));
    const cookie = response.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    const url = manifest.sources.find((s) => s.kind === "hls").url;
    assert.equal((await fetch(url)).status, 403);
    const master = await fetch(url, { headers: { Cookie: cookie } });
    assert.equal(master.status, 200);
    const text = await master.text();
    assert.match(text, /1080p/);
    const variantUrl = new URL("1080p/index.m3u8", url).href;
    const playlist = await (
      await fetch(variantUrl, { headers: { Cookie: cookie } })
    ).text();
    const segment = playlist.split(/\r?\n/).find((l) => l.endsWith(".ts"));
    const segmentUrl = new URL(segment, variantUrl).href;
    assert.equal((await fetch(segmentUrl)).status, 403);
    const ranged = await fetch(segmentUrl, {
      headers: { Cookie: cookie, Range: "bytes=0-187" },
    });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 188);
    const other = await file();
    const crossed = url
      .replace(row.id, other.row.id)
      .replace(jobId, other.jobId);
    assert.equal(
      (await fetch(crossed, { headers: { Cookie: cookie } })).status,
      403,
    );
    const session = await db.classSession.create({
      data: {
        kind: "GROUP",
        groupId: group.id,
        createdById: owner.id,
        scheduledAt: new Date(),
        title: "Recorded",
        joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
      },
    });
    const recording = await db.classRecording.create({
      data: {
        id: randomUUID(),
        sessionId: session.id,
        recorderId: owner.id,
        status: "SAVED",
        fileId: row.id,
      },
    });
    const status = await f.api(
      viewer,
      "GET",
      `/recordings/${recording.id}/processing`,
    );
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "READY");
    assert.equal(
      (
        await f.api(
          owner,
          "POST",
          `/recordings/${recording.id}/processing/retry`,
          {},
          "new",
        )
      ).status,
      409,
    );
    await db.groupMember.delete({
      where: { userId_groupId: { userId: viewer.id, groupId: group.id } },
    });
    assert.equal(
      (await f.api(viewer, "POST", `/files/${row.id}/playback`)).status,
      403,
    );
    await db.groupMember.create({
      data: { groupId: group.id, userId: viewer.id, role: "VIEWER" },
    });
  },
  { timeout: 120000 },
);
test(
  "worker recovery fences an expired attempt; retry is authorized and idempotent; terminal snapshot immutable",
  async () => {
    const { row, jobId } = await file();
    const stale = await service.claim(randomUUID(), jobId);
    assert.equal(await service.claim(randomUUID(), jobId), null);
    await db.videoJob.update({
      where: { id: jobId },
      data: { leaseUntil: new Date(0) },
    });
    const resumed = await service.claim(randomUUID(), jobId);
    assert.equal(resumed.attemptNo, 2);
    assert.equal(await service.publish(stale, { test: "invalid" }), false);
    await service.fail(resumed, "ENCODE_FAILED");
    assert.equal(
      (
        await f.api(
          viewer,
          "POST",
          `/files/${row.id}/processing/retry`,
          {},
          "key",
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api(owner, "POST", `/files/${row.id}/processing/retry`, {}))
        .status,
      400,
    );
    assert.equal(
      (
        await f.api(
          owner,
          "POST",
          `/files/${row.id}/processing/retry`,
          { objectKey: "forged" },
          "key",
        )
      ).status,
      400,
    );
    const a = await f.api(
      owner,
      "POST",
      `/files/${row.id}/processing/retry`,
      {},
      "key",
    );
    assert.equal(a.status, 202);
    const b = await f.api(
      owner,
      "POST",
      `/files/${row.id}/processing/retry`,
      {},
      "key",
    );
    assert.deepEqual(a.body, b.body);
    assert.equal(
      (
        await f.api(
          owner,
          "POST",
          `/files/${row.id}/processing/retry`,
          {},
          "other",
        )
      ).status,
      409,
    );
    await worker.once(a.body.jobId);
    assert.equal((await service.snapshot(row.id)).status, "READY");
    await assert.rejects(
      db.videoJob.update({
        where: { id: a.body.jobId },
        data: { state: "PROCESSING" },
      }),
    );
  },
  { timeout: 120000 },
);
test(
  "HLS-only T11 import reuses existing output and disables original download; missing segment never publishes",
  async () => {
    const { row, jobId } = await file();
    await worker.once(jobId);
    const ready = await db.videoJob.findUnique({ where: { id: jobId } }),
      output = ready.output;
    const session = await db.classSession.create({
      data: {
        kind: "GROUP",
        groupId: group.id,
        createdById: owner.id,
        scheduledAt: new Date(),
        title: "IVS",
        joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
      },
    });
    const recordingId = randomUUID();
    await db.recordingAsset.create({
      data: { id: recordingId, sessionId: session.id },
    });
    const registered = await f.app.get(FilesService).registerRecording({
      recordingId,
      groupId: group.id,
      sourceObjectKey: output.masterKey,
      size: 0,
      mimeType: "application/vnd.apple.mpegurl",
      status: "AVAILABLE",
      storageLocationId: row.storageLocationId,
      videoSource: {
        kind: "HLS",
        storageLocationId: row.storageLocationId,
        prefix: output.prefix,
        masterKey: output.masterKey,
        channelType: "STANDARD",
        renditionSelection: "ALL",
        expectedHeights: [1080, 720, 360],
      },
    });
    const asset = await db.videoAsset.findUnique({
      where: { fileId: registered.fileId },
    });
    await worker.once(asset.currentJobId);
    const playback = await f.api(
      owner,
      "POST",
      `/files/${registered.fileId}/playback`,
    );
    assert.equal(playback.status, 200);
    assert.equal(playback.body.sources.length, 1);
    assert.equal(playback.body.sources[0].kind, "hls");
    assert.equal(
      (await f.api(owner, "POST", `/files/${registered.fileId}/download-url`))
        .status,
      409,
    );
    assert.equal(
      (await f.api(owner, "GET", `/files/${registered.fileId}`)).body.file
        .canDownload,
      false,
    );
    const playlist = await readFile(
      join(f.config.files.localDirectory, output.renditions[0].variantKey),
      "utf8",
    );
    const segment = playlist.split(/\r?\n/).find((l) => l.endsWith(".ts"));
    await unlink(
      join(
        f.config.files.localDirectory,
        output.renditions[0].variantKey,
        "..",
        segment,
      ),
    );
    const imported = await file(clip);
    await db.videoAsset.update({
      where: { fileId: imported.row.id },
      data: { sourceMetadata: { trusted: true } },
    });
    const verify =
      require("../../dist/modules/video-processing/video-finalizer").verifyHls;
    await assert.rejects(
      verify(
        worker.storage,
        row.storageLocationId,
        output.prefix,
        output.masterKey,
      ),
      /RENDITION_MISSING/,
    );
  },
  { timeout: 120000 },
);
test(
  "portrait and short 4K encode produce real dimensions without upscale",
  async () => {
    for (const [width, height, cap, expected] of [
      [720, 1280, 1080, [1280, 640]],
      [3840, 2160, 2160, [2160, 1080, 720, 360]],
      [240, 136, 1080, [136]],
    ]) {
      const path = join(
        f.config.files.localDirectory,
        `${width}-${height}.mp4`,
      );
      await runProcess(f.config.video.ffmpegPath, [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=green:s=${width}x${height}:r=4:d=1`,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "2",
        path,
      ]);
      f.config.video.maxQuality = cap;
      const { jobId } = await file(path);
      await worker.once(jobId);
      const job = await db.videoJob.findUnique({ where: { id: jobId } });
      assert.equal(job.state, "READY", job.errorCode);
      assert.deepEqual(
        job.output.renditions.map((r) => r.height),
        expected,
      );
    }
  },
  { timeout: 180000 },
);
test("multipart completion detects video content and atomically enqueues processing and transcription once", async (t) => {
  let signals = 0;
  const notified = () => signals++;
  service.on("queued", notified);
  t.after(() => service.off("queued", notified));
  const bytes = await readFile(clip);
  const multipart = f.app.get(
    require("../../dist/modules/uploads/multipart-storage.service")
      .MultipartStorageService,
  );
  multipart.local.options.port = 0;
  const created = await f.api(owner, "POST", "/uploads", {
    groupId: group.id,
    filename: "Content.pdf",
    mimeType: "application/pdf",
    size: bytes.length,
    source: "DOCUMENT",
    fingerprint: "video-content",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.uploadId;
  const signed = await f.api(owner, "POST", `/uploads/${id}/parts/sign`, {
    partNumbers: [1],
  });
  assert.equal(signed.status, 200);
  const put = await fetch(signed.body.parts[0].url, {
    method: "PUT",
    body: bytes,
  });
  assert.equal(put.status, 200);
  const body = { parts: [{ partNumber: 1, etag: put.headers.get("etag") }] };
  const completed = await f.api(
    owner,
    "POST",
    `/uploads/${id}/complete`,
    body,
    "complete",
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(signals, 1, "upload completion must wake the shared worker");
  const upload = await db.uploadSession.findUnique({ where: { id } }),
    asset = await db.videoAsset.findUnique({
      where: { fileId: upload.fileId },
    });
  assert.ok(asset.currentJobId);
  assert.equal(
    (await db.libraryFile.findUnique({ where: { id: upload.fileId } }))
      .mimeType,
    "video/mp4",
  );
  assert.equal(
    (await f.api(owner, "POST", `/uploads/${id}/complete`, body, "complete"))
      .status,
    200,
  );
  assert.equal(
    await db.videoJob.count({ where: { fileId: upload.fileId } }),
    1,
  );
  assert.equal(
    await db.videoTranscript.count({ where: { fileId: upload.fileId } }),
    1,
  );
  const transcript = await db.videoTranscript.findUnique({
    where: { fileId: upload.fileId },
  });
  assert.equal(transcript.transcriptStatus, "PENDING");
  // Saved captions remain readable when the speech worker is disabled locally.
  const cues = [{ startMs: 0, endMs: 1500, text: "Video pipeline transcript" }];
  await db.videoTranscript.update({
    where: { fileId: upload.fileId },
    data: { transcriptStatus: "READY", transcriptCues: cues },
  });
  const response = await f.api(
    owner,
    "GET",
    `/files/${upload.fileId}/transcript`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "READY", cues });
  assert.equal(
    (await f.api(outsider, "GET", `/files/${upload.fileId}/transcript`)).status,
    403,
  );
  await worker.once(asset.currentJobId);
  assert.equal(
    (await db.videoJob.findUnique({ where: { id: asset.currentJobId } })).state,
    "READY",
  );
  assert.deepEqual(
    (await f.api(owner, "GET", `/files/${upload.fileId}/transcript`)).body,
    { status: "READY", cues },
  );
});

test("API and local workers cannot claim managed outbox jobs", async () => {
  const {
    VideoJobsService,
  } = require("../../dist/modules/video-processing/video-jobs.service");
  const apiStore = new VideoJobsService(db, {
    video: { ...f.config.video, mode: "aws" },
  });
  const managed = await file();
  await db.videoJob.update({
    where: { id: managed.jobId },
    data: { encoder: "mediaconvert" },
  });
  assert.equal(await service.claim(randomUUID(), managed.jobId), null);
  assert.equal(await apiStore.claim(randomUUID(), managed.jobId), null);
});

test("finished recordings wake the worker after registration while pending and rejected registrations do not", async () => {
  const session = await db.classSession.create({
    data: {
      groupId: group.id,
      createdById: owner.id,
      title: "Recording signal",
      kind: "GROUP",
      scheduledAt: new Date(),
      joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
    },
  });
  const recording = await db.recordingAsset.create({
    data: { id: randomUUID(), sessionId: session.id },
  });
  const files = f.app.get(FilesService);
  let signals = 0;
  const notified = () => signals++;
  service.on("queued", notified);
  try {
    const input = {
      recordingId: recording.id,
      groupId: group.id,
      sourceObjectKey: "recordings/complete.mp4",
      size: 12,
      mimeType: "video/mp4",
      status: "PENDING",
    };
    const pending = await files.registerRecording(input);
    assert.equal(signals, 0);
    assert.equal(
      await db.videoJob.count({ where: { fileId: pending.fileId } }),
      0,
    );
    const done = await files.registerRecording({
      ...input,
      status: "AVAILABLE",
    });
    assert.equal(signals, 1);
    assert.equal(
      await db.videoJob.count({
        where: { fileId: done.fileId, state: "QUEUED" },
      }),
      1,
    );
    await files.registerRecording({ ...input, status: "AVAILABLE" });
    assert.equal(
      await db.videoJob.count({ where: { fileId: done.fileId } }),
      1,
    );
    const before = signals;
    await assert.rejects(
      files.registerRecording({
        ...input,
        sourceObjectKey: "wrong.mp4",
        status: "AVAILABLE",
      }),
    );
    assert.equal(signals, before, "a rolled-back registration must not notify");
  } finally {
    service.off("queued", notified);
  }
});

test("local retention does not clean mirrored AWS jobs", async () => {
  const { row } = await file();
  const old = new Date(Date.now() - 8 * 86400000);
  const jobs = [];
  for (const encoder of ["ffmpeg", "mediaconvert"])
    jobs.push(
      await db.videoJob.create({
        data: {
          fileId: row.id,
          mode: "TRANSCODE",
          encoder,
          state: "FAILED",
          createdAt: old,
          updatedAt: old,
        },
      }),
    );
  const prefixes = [],
    remove = worker.storage.removePrefix;
  worker.storage.removePrefix = async (_location, prefix) =>
    prefixes.push(prefix);
  worker.lastRetentionAt = 0;
  worker.retentionCursor = undefined;
  try {
    await worker.retention();
    const root = `groups/${group.id}/videos/${row.id}/`;
    assert.ok(prefixes.includes(root + jobs[0].id));
    assert.ok(
      !prefixes.includes(root + jobs[1].id),
      "DynamoDB/Lambda owns cleanup of AWS outputs",
    );
  } finally {
    worker.storage.removePrefix = remove;
  }
});
