const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomBytes, createHash } = require("node:crypto");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  LocalMultipartStorage,
} = require("../dist/modules/uploads/local-multipart-storage");
const {
  MultipartStorageService,
} = require("../dist/modules/uploads/multipart-storage.service");

test("T16 local storage: parallel parts, CORS, invalid signatures, size bounds, complete and abort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "streamora-multipart-test-"));
  const local = new LocalMultipartStorage({
    directory,
    secret: randomBytes(32).toString("hex"),
    origin: "http://127.0.0.1:3000",
    port: 0,
  });
  try {
    const id = await local.create(
      "groups/test/object",
      21,
      10,
      Date.now() + 60000,
    );
    const urls = await Promise.all([1, 2, 3].map((n) => local.sign(id, n, 60)));
    const cors = await fetch(urls[0], {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:3000" },
    });
    assert.equal(cors.headers.get("access-control-expose-headers"), "ETag");
    assert.equal(
      (
        await fetch(urls[0] + "tampered", {
          method: "PUT",
          body: Buffer.alloc(10),
        })
      ).status,
      403,
    );
    const expired = await local.sign(id, 1, -1);
    assert.equal(
      (await fetch(expired, { method: "PUT", body: Buffer.alloc(10) })).status,
      403,
    );
    assert.equal(
      (await fetch(urls[0], { method: "PUT", body: Buffer.alloc(9) })).status,
      403,
    );
    const buffers = [
      Buffer.alloc(10, 1),
      Buffer.alloc(10, 2),
      Buffer.alloc(1, 3),
    ];
    const results = await Promise.all(
      urls.map((url, index) =>
        fetch(url, { method: "PUT", body: buffers[index] }),
      ),
    );
    results.forEach((result) => assert.equal(result.status, 200));
    const parts = await local.list(id);
    assert.equal(parts.length, 3);
    await assert.rejects(local.complete(id, parts.slice(1), async () => {}));
    let bytes;
    await local.complete(id, parts, async (path) => {
      bytes = await readFile(path);
    });
    assert.deepEqual(bytes, Buffer.concat(buffers));
    assert.equal(
      (await fetch(urls[0], { method: "PUT", body: buffers[0] })).status,
      403,
    );
    await local.abort(id);
    await local.abort(id);
    assert.equal(
      (await fetch(urls[0], { method: "PUT", body: buffers[0] })).status,
      403,
    );
  } finally {
    await local.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("T16 S3 scaffold signs real SigV4 UploadPart URLs without network or real credentials", async () => {
  const previous = {
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    token: process.env.AWS_SESSION_TOKEN,
  };
  process.env.AWS_ACCESS_KEY_ID = "test-upload-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-upload-secret";
  delete process.env.AWS_SESSION_TOKEN;
  const storage = new MultipartStorageService(
    {
      files: {
        driver: "s3",
        bucket: "streamora-test",
        region: "ap-southeast-1",
      },
    },
    {},
  );
  try {
    const url = new URL(
      await storage.sign(
        "groups/group/uploads/file",
        "storage-upload-id",
        2,
        60,
      ),
    );
    assert.equal(
      url.hostname,
      "streamora-test.s3.ap-southeast-1.amazonaws.com",
    );
    assert.equal(url.searchParams.get("partNumber"), "2");
    assert.equal(url.searchParams.get("uploadId"), "storage-upload-id");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
    assert.equal(url.searchParams.has("x-amz-checksum-crc32"), false);
    assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  } finally {
    await storage.onModuleDestroy();
    for (const [name, value] of [
      ["AWS_ACCESS_KEY_ID", previous.key],
      ["AWS_SECRET_ACCESS_KEY", previous.secret],
      ["AWS_SESSION_TOKEN", previous.token],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Local resume reuses streamed ETags and invalidates the cache when a part changes", async () => {
  const fs = require("node:fs");
  const { writeFile, stat, utimes } = require("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "streamora-part-cache-"));
  const local = new LocalMultipartStorage({
    directory,
    secret: "cache-test",
    origin: "http://127.0.0.1:3000",
    port: 0,
  });
  const originalStream = fs.createReadStream;
  let reads = 0;
  try {
    const id = await local.create(
      "groups/test/cache",
      1024,
      1024,
      Date.now() + 60000,
    );
    const url = await local.sign(id, 1, 60);
    const uploaded = await fetch(url, {
      method: "PUT",
      body: Buffer.alloc(1024, 1),
    });
    assert.equal(uploaded.status, 200);
    fs.createReadStream = (...args) => {
      reads++;
      return originalStream(...args);
    };
    const first = await local.list(id);
    assert.equal(first[0].etag, uploaded.headers.get("etag"));
    await local.list(id);
    assert.equal(
      reads,
      0,
      "Listing unchanged parts must not read or hash their contents again",
    );
    const path = join(directory, id, "1.part");
    const before = await stat(path);
    await writeFile(path, Buffer.alloc(1024, 2));
    await utimes(path, before.atime, before.mtime); // ctime must also be checked, not just size/mtime.
    const changed = await local.list(id);
    assert.notEqual(changed[0].etag, first[0].etag);
    assert.equal(reads, 1);
    await local.list(id);
    assert.equal(reads, 1);
    await local.abort(id);
    await assert.rejects(local.list(id), (error) => error.code === "ENOENT");
  } finally {
    fs.createReadStream = originalStream;
    await local.close();
    await rm(directory, { recursive: true, force: true });
  }
});
