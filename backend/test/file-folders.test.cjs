const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createValidationPipe } = require("../dist/common/validation");
const { FileListQueryDto } = require("../dist/modules/files/files.dto");
const { FilesService } = require("../dist/modules/files/files.service");

test("folder paths are validated and listing returns immediate children", async () => {
  const pipe = createValidationPipe();
  const validate = (value) =>
    pipe.transform(value, { type: "query", metatype: FileListQueryDto });
  for (const folderPath of ["/a", "a/", "a//b", "a\\b", "a\n"])
    await assert.rejects(validate({ folderPath }));
  assert.equal(
    (await validate({ folderPath: "Tài liệu/Bài 1" })).folderPath,
    "Tài liệu/Bài 1",
  );
  const calls = [];
  const prisma = {
    libraryFile: {
      findMany: async (options) => {
        calls.push(options);
        return options.select
          ? [
              { folderPath: "Tài liệu/Bài 1" },
              { folderPath: "Tài liệu/Bài 1/Ảnh" },
              { folderPath: "Tài liệu/Bài 2" },
            ]
          : [];
      },
    },
  };
  const service = new FilesService(
    prisma,
    { require: async () => ({}) },
    {},
    {},
  );
  const result = await service.list("user", "group", {
    folderPath: "Tài liệu",
    limit: 20,
  });
  assert.deepEqual(result.folders, ["Bài 1", "Bài 2"]);
  assert.equal(calls[0].where.folderPath, "Tài liệu");
  assert.equal(calls[1].where.folderPath.startsWith, "Tài liệu/");
});
const { Readable } = require("node:stream");
const {
  FolderDto,
  RenameFolderDto,
} = require("../dist/modules/files/files.dto");

test("folders are excluded from video filter", async () => {
  const service = new FilesService(
    { libraryFile: { findMany: async () => [] } },
    { require: async () => ({}) },
    {},
    {},
  );
  assert.deepEqual(
    (await service.list("u", "g", { type: "video", limit: 20 })).folders,
    [],
  );
});

function folderFixture({
  owner = "u",
  host = false,
  busy = 0,
  usage = 0,
  collision = 0,
} = {}) {
  const rows = [
    {
      id: "1",
      folderPath: "Lessons",
      createdBy: owner,
      status: "AVAILABLE",
      objectKey: "a",
      name: "a.txt",
    },
    {
      id: "2",
      folderPath: "Lessons/Sub",
      createdBy: owner,
      status: "AVAILABLE",
      objectKey: "b",
      name: "b.txt",
    },
  ];
  const updates = [],
    deletions = [],
    removed = [];
  const tx = {
    $queryRaw: async () => [],
    libraryFile: {
      findMany: async () => rows,
      count: async () => collision,
      update: async (q) => updates.push(q),
    },
    uploadSession: { count: async () => busy },
    fileUsage: { count: async () => usage },
    fileObjectDeletion: { create: async (q) => deletions.push(q) },
  };
  const prisma = {
    $transaction: async (fn) => fn(tx),
    libraryFile: tx.libraryFile,
    fileObjectDeletion: { update: async () => {} },
  };
  const service = new FilesService(
    prisma,
    { require: async () => ({ canHost: host }) },
    {
      delete: async (key) => removed.push(key),
      read: async (key) => Readable.from([Buffer.from(key)]),
    },
    {},
  );
  return { service, updates, deletions, removed };
}

test("folder names and paths reject traversal and separators", async () => {
  const pipe = createValidationPipe();
  for (const folderPath of [
    "../Lessons",
    "Lessons/..",
    "/Lessons",
    "Lessons//Sub",
  ])
    await assert.rejects(
      pipe.transform({ folderPath }, { type: "body", metatype: FolderDto }),
    );
  for (const name of ["..", "a/b", "a\\b", ""])
    await assert.rejects(
      pipe.transform(
        { folderPath: "Lessons", name },
        { type: "body", metatype: RenameFolderDto },
      ),
    );
});

test("renaming changes all descendants; deleting queues and removes each object", async () => {
  const f = folderFixture();
  await f.service.changeFolder("u", "g", "Lessons", "New");
  assert.deepEqual(
    f.updates.map((q) => q.data.folderPath),
    ["New", "New/Sub"],
  );
  const d = folderFixture();
  await d.service.changeFolder("u", "g", "Lessons");
  assert.equal(d.deletions.length, 2);
  assert.deepEqual(d.removed, ["a", "b"]);
  assert.ok(d.updates.every((q) => q.data.status === "DELETED"));
});

test("folder changes reject unauthorized descendants, active uploads, collisions and in-use files before writing", async () => {
  for (const options of [{ owner: "other" }, { busy: 1 }, { collision: 1 }]) {
    const f = folderFixture(options);
    await assert.rejects(f.service.changeFolder("u", "g", "Lessons", "New"));
    assert.equal(f.updates.length, 0);
  }
  const f = folderFixture({ usage: 1 });
  await assert.rejects(f.service.changeFolder("u", "g", "Lessons"));
  assert.equal(f.updates.length, 0);
});

test("folder download produces ZIP with nested paths and file bytes", async () => {
  const f = folderFixture();
  const stream = await f.service.downloadFolder("u", "g", "Lessons");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const zip = Buffer.concat(chunks);
  assert.equal(zip.readUInt32LE(), 0x04034b50);
  assert.ok(zip.includes(Buffer.from("Lessons/a.txt")));
  assert.ok(zip.includes(Buffer.from("Lessons/Sub/b.txt")));
  assert.ok(zip.includes(Buffer.from("PK")));
});

test("search returns matching files across nested folders without folder rows", async () => {
  const calls = [];
  const nested = {
    id: "nested",
    groupId: "g",
    name: "Bài giảng.pdf",
    folderPath: "Lessons/Sub",
    size: 12n,
    mimeType: "application/pdf",
    source: "DOCUMENT",
    status: "AVAILABLE",
    sessionId: null,
    recordingId: null,
    createdBy: "u",
    createdAt: new Date(),
  };
  const service = new FilesService(
    {
      libraryFile: {
        findMany: async (options) => {
          calls.push(options);
          return [nested];
        },
      },
    },
    { require: async () => ({}) },
    {},
    {},
  );
  const result = await service.list("u", "g", { q: "Bài", limit: 20 });
  assert.equal(result.items[0].id, "nested");
  assert.deepEqual(result.folders, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.folderPath, undefined);
  assert.deepEqual(calls[0].where.name, {
    contains: "Bài",
    mode: "insensitive",
  });
  calls.length = 0;
  await service.list("u", "g", { q: "Bài", folderPath: "Lessons", limit: 20 });
  assert.deepEqual(calls[0].where.AND[0].OR, [
    { folderPath: "Lessons" },
    { folderPath: { startsWith: "Lessons/" } },
  ]);
});
