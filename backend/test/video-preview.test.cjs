const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { byteRange } = require("../dist/modules/files/byte-range");
const {
  LocalFileStorage,
} = require("../dist/modules/files/local-file-storage");
const {
  VideoPlaybackService,
} = require("../dist/modules/files/video-playback.service");
const {
  SourceOnlyVideoCatalog,
} = require("../dist/modules/files/video-rendition-catalog");
async function bytes(stream) {
  const result = [];
  for await (const chunk of stream) result.push(chunk);
  return Buffer.concat(result);
}

test("video byte ranges handle bounded, suffix, open-ended and unsatisfiable requests", () => {
  assert.deepEqual(byteRange("bytes=2-4", 10), { start: 2, end: 4 });
  assert.deepEqual(byteRange("bytes=8-999", 10), { start: 8, end: 9 });
  assert.deepEqual(byteRange("bytes=8-", 10), { start: 8, end: 9 });
  assert.deepEqual(byteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange("bytes=-99", 10), { start: 0, end: 9 });
  for (const range of [
    "bytes=10-",
    "bytes=9-1",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,4-5",
    "bytes=9999999999999999999999-",
    "items=0-1",
  ])
    assert.equal(byteRange(range, 10), null);
});

test("local video streams real ranges and HEAD without loading the whole file; expiry and MIME stay protected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "streamora-video-range-"));
  try {
    const local = new LocalFileStorage({
      directory: join(dir, "objects"),
      secret: "video-range-test",
      ttlSeconds: 60,
      baseUrl: "http://127.0.0.1:4000",
    });
    const source = join(dir, "source.mp4"),
      body = Buffer.concat([
        Buffer.from("000000186674797069736f6d", "hex"),
        Buffer.alloc(200, 42),
      ]);
    await writeFile(source, body);
    await local.importFile(source, "groups/test/video");
    const signed = await local.download(
      "groups/test/video",
      "video.mp4",
      1000,
      true,
      "video/mp4",
    );
    const token = new URL(signed.url).searchParams.get("token");
    const range = await local.openDownload(token, 2000, "bytes=50-99");
    assert.equal(range.status, 206);
    assert.equal(range.contentRange, `bytes 50-99/${body.length}`);
    assert.equal(range.type, "video/mp4");
    assert.deepEqual(await bytes(range.stream), body.subarray(50, 100));
    const suffix = await local.openDownload(token, 2000, "bytes=-5");
    assert.deepEqual(await bytes(suffix.stream), body.subarray(-5));
    const bad = await local.openDownload(token, 2000, "bytes=9999-");
    assert.equal(bad.status, 416);
    assert.equal(bad.contentRange, `bytes */${body.length}`);
    assert.equal((await bytes(bad.stream)).length, 0);
    const head = await local.openDownload(token, 2000, undefined, true);
    assert.equal(head.size, body.length);
    assert.equal((await bytes(head.stream)).length, 0);
    for (let i = 0; i < 20; i++) {
      const interrupted = await local.openDownload(token, 2000, "bytes=0-");
      await new Promise((resolve) => {
        interrupted.stream.once("close", resolve);
        interrupted.stream.destroy();
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (global.gc) global.gc();
    await assert.rejects(
      local.openDownload(token, 62000, "bytes=0-1"),
      (e) => e.getStatus() === 403,
    );
    const spoofed = await local.download(
      "groups/test/video",
      "video.webm",
      1000,
      true,
      "video/webm",
    );
    await assert.rejects(
      local.openDownload(new URL(spoofed.url).searchParams.get("token"), 2000),
      (e) => e.getStatus() === 415,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("video manifest exposes only real published qualities and never leaks keys", async () => {
  const file = {
    id: "file",
    groupId: "group",
    name: "Video.webm",
    mimeType: "video/webm",
    objectKey: "groups/group/uploads/file",
  };
  const signed = [];
  const storage = {
    download: async (key, _name, preview, type, location) => {
      signed.push({ key, preview, type, location });
      return {
        url: `https://storage.test/${signed.length}`,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    },
  };
  const sourceOnly = await new VideoPlaybackService(
    storage,
    new SourceOnlyVideoCatalog(),
  ).manifest(file, {});
  assert.equal(sourceOnly.sources.length, 1);
  assert.equal(sourceOnly.sources[0].label, "Bản gốc");
  assert.equal(sourceOnly.processing.progressPercent, null);
  const catalog = {
    read: async () => ({
      status: "READY",
      progressPercent: null,
      renditions: [
        {
          id: "360p",
          height: 360,
          bitrate: 500000,
          mimeType: "video/webm",
          objectKey: "groups/group/videos/file/v1/360.webm",
        },
      ],
    }),
  };
  const result = await new VideoPlaybackService(storage, catalog).manifest(
    file,
    {},
  );
  assert.equal(result.sources[1].label, "360p");
  assert.equal(JSON.stringify(result).includes("objectKey"), false);
  assert.equal(signed.at(-1).type, "video/webm");
  catalog.read = async () => ({
    status: "READY",
    progressPercent: null,
    renditions: [],
    hls: {
      url: "https://cdn.test/master.m3u8",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    },
  });
  await assert.rejects(
    new VideoPlaybackService(storage, catalog).manifest(file, {}),
    (e) => e.getStatus() === 503,
  );
  catalog.read = async () => ({
    status: "READY",
    progressPercent: null,
    renditions: [],
    hls: {
      url: "https://cdn.test/master.m3u8",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  });
  assert.equal(
    (await new VideoPlaybackService(storage, catalog).manifest(file, {}))
      .sources[1].kind,
    "hls",
  );
  catalog.read = async () => ({
    status: "READY",
    progressPercent: null,
    renditions: [
      {
        id: "360p",
        height: 360,
        bitrate: 500000,
        mimeType: "video/webm",
        objectKey: "groups/other/videos/file/360.webm",
      },
    ],
  });
  await assert.rejects(
    new VideoPlaybackService(storage, catalog).manifest(file, {}),
    (e) => e.getStatus() === 503,
  );
  await assert.rejects(
    new VideoPlaybackService(storage, catalog).manifest(
      { ...file, mimeType: "text/html" },
      {},
    ),
    (e) => e.getStatus() === 415,
  );
});
