const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { S3Client } = require("@aws-sdk/client-s3");
const { createValidationPipe } = require("../dist/common/validation");
const {
  FileListQueryDto,
  RenameFileDto,
} = require("../dist/modules/files/files.dto");
const {
  FileStorageService,
} = require("../dist/modules/files/file-storage.service");
const { FilesService } = require("../dist/modules/files/files.service");
const {
  FileCleanupService,
} = require("../dist/modules/files/file-cleanup.service");
const pipe = createValidationPipe();
const validate = (type, value, location = "body") =>
  pipe.transform(value, { type: location, metatype: type });

test("T15 validates names, pagination and rejects forged object keys/owners", async () => {
  for (const name of [
    "",
    "   ",
    "\u0000file",
    "a\nb",
    "x".repeat(256),
    null,
    1,
  ])
    await assert.rejects(validate(RenameFileDto, { name }));
  for (const extra of [
    { objectKey: "other" },
    { createdBy: randomUUID() },
    { status: "AVAILABLE" },
  ])
    await assert.rejects(
      validate(RenameFileDto, { name: "Name.pdf", ...extra }),
    );
  for (const q of [
    { type: "recording" },
    { type: ["video"] },
    { limit: "0" },
    { limit: "101" },
    { q: ["a"] },
  ])
    await assert.rejects(validate(FileListQueryDto, q, "query"));
  assert.equal(
    (await validate(RenameFileDto, { name: "  Bài giảng.pdf  " })).name,
    "Bài giảng.pdf",
  );
});

test("T15 unavailable storage fails closed, signer uses real SigV4 and short TTL", async () => {
  const storage = new FileStorageService({});
  await assert.rejects(
    storage.download("key", "name"),
    (e) => e.getStatus() === 503,
  );
  storage.onModuleDestroy();
  // Explicit fictitious credentials, offline cryptographic signing only.
  const client = new S3Client({
    region: "ap-southeast-1",
    credentials: {
      accessKeyId: "TESTONLY",
      secretAccessKey: "test-only-secret",
    },
  });
  const service = new FileStorageService({
    files: {
      bucket: "streamora-test",
      region: "ap-southeast-1",
      downloadTtlSeconds: 120,
    },
  });
  service.client.destroy();
  service.client = client;
  const before = Date.now();
  const response = await service.download("files/a b.pdf", "Bài giảng.pdf");
  const url = new URL(response.url);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
  assert.ok(Date.parse(response.expiresAt) >= before + 60000);
  assert.ok(Date.parse(response.expiresAt) <= Date.now() + 60000);
  assert.match(
    url.searchParams.get("response-content-disposition"),
    /filename\*=UTF-8''B%C3%A0i/,
  );
  assert.ok(url.searchParams.get("X-Amz-Signature"));
  assert.equal(url.protocol, "https:");
  const preview = new URL(
    (await service.download("files/a.pdf", "A.pdf", true)).url,
  );
  assert.match(
    preview.searchParams.get("response-content-disposition"),
    /^inline;/,
  );
  assert.equal(
    preview.searchParams.get("response-content-type"),
    "application/pdf",
  );
  const image = new URL(
    (await service.download("files/image.png", "Ảnh.png", true, "image/png"))
      .url,
  );
  assert.equal(image.searchParams.get("response-content-type"), "image/png");
  assert.match(
    image.searchParams.get("response-content-disposition"),
    /^inline;/,
  );
  client.destroy();
});

test("T15 checks authorization before even an empty search; rejects cross-filter cursors", async () => {
  let reads = 0;
  const files = new FilesService(
    {
      libraryFile: {
        findMany: async () => {
          reads++;
          return [];
        },
      },
    },
    {
      require: async () => {
        throw new Error("denied");
      },
    },
    {},
  );
  await assert.rejects(files.list("u", "g", { q: "", limit: 20 }), /denied/);
  assert.equal(reads, 0);
  files.access.require = async () => ({});
  await assert.rejects(
    files.list("u", "g", { limit: 20, cursor: "invalid" }),
    (e) => e.getStatus() === 400,
  );
});

test("T15 cleanup retains failed jobs and retries successfully", async () => {
  let completed = false,
    attempts = 0,
    deleted = false;
  const db = {
    $executeRaw: async (sql) => {
      if (String(sql).includes("SET attempts")) attempts++;
    },
    $queryRaw: async () => {
      if (completed || attempts > 0) return [];
      attempts++;
      return [
        {
          file_id: "id",
          object_key: "key",
          storage_location_id: "location",
          attempts,
        },
      ];
    },
    fileObjectDeletion: {
      update: async ({ data }) => {
        if (data.attempts) attempts++;
        if (data.completedAt) completed = true;
      },
    },
  };
  const prisma = { ...db, $transaction: async (fn) => fn(db) };
  const storage = {
    delete: async (key, location) => {
      assert.equal(key, "key");
      assert.equal(location, "location");
      if (!deleted) throw Error("offline");
    },
  };
  const worker = new FileCleanupService(prisma, storage, {});
  await worker.tick();
  assert.equal(completed, false);
  assert.equal(attempts, 1);
  deleted = true;
  attempts = 0;
  await worker.tick();
  assert.equal(completed, true);
});
