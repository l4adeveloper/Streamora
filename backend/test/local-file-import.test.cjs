const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { folderFiles } = require("../scripts/import-local-file.cjs");
test("folder import finds nested files, supports top-level only and excludes its own storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "streamora-folder-test-"));
  try {
    await mkdir(join(root, "chapter"));
    await mkdir(join(root, "storage"));
    await writeFile(join(root, "lesson.txt"), "first");
    await writeFile(join(root, "chapter", "lesson.txt"), "second");
    await writeFile(join(root, "storage", "internal.txt"), "must not import");
    const collect = async (options) => {
      const files = [];
      for await (const file of folderFiles(root, options))
        files.push(file.name);
      return files.sort();
    };
    const options = { storageDirectory: join(root, "storage") };
    assert.deepEqual(await collect(options), [
      "chapter/lesson.txt",
      "lesson.txt",
    ]);
    assert.deepEqual(await collect({ ...options, recursive: false }), [
      "lesson.txt",
    ]);
    await assert.rejects(async () => {
      for await (const file of folderFiles(join(root, "storage"), options)) {
      }
    }, /lưu trữ nội bộ/);
    await assert.rejects(async () => {
      for await (const file of folderFiles(join(root, "lesson.txt"))) {
      }
    }, /thư mục thật/);
  } finally {
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});
