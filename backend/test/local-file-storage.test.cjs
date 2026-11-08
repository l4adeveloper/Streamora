const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const {
  LocalFileStorage,
} = require("../dist/modules/files/local-file-storage");

test("T15 local serves real bytes, signs expiry, rejects tampering and deletes only its copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "streamora-local-test-"));
  try {
    const source = join(dir, "source.txt");
    const body = Buffer.from("Bài giảng tiếng Việt\n".repeat(1000));
    await writeFile(source, body);
    const local = new LocalFileStorage({
      directory: join(dir, "objects"),
      secret: "local-test-secret",
      ttlSeconds: 120,
      baseUrl: "http://127.0.0.1:4000",
    });
    await local.importFile(source, "local/example");
    const issued = await local.download("local/example", "Bài giảng.txt", 1000);
    const token = new URL(issued.url).searchParams.get("token");
    const opened = await local.openDownload(token, 2000);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), body);
    assert.equal(opened.size, body.length);
    assert.match(opened.disposition, /^attachment;/);
    await assert.rejects(
      local.openDownload(token, 121000),
      (e) => e.getStatus() === 403,
    );
    await assert.rejects(
      local.openDownload(`x${token}`, 2000),
      (e) => e.getStatus() === 403,
    );
    const other = new LocalFileStorage({
      directory: join(dir, "objects"),
      secret: "other-secret",
      ttlSeconds: 120,
      baseUrl: "http://127.0.0.1:4000",
    });
    await assert.rejects(
      other.openDownload(token, 2000),
      (e) => e.getStatus() === 403,
    );
    await local.delete("local/example");
    await local.delete("local/example");
    await assert.rejects(
      local.openDownload(token, 2000),
      (e) => e.getStatus() === 404,
    );
    assert.deepEqual(await readFile(source), body);
    await writeFile(source, require("./pdf-fixture.cjs").pdfFixture());
    await local.importFile(source, "local/pdf");
    const preview = await local.download(
      "local/pdf",
      "preview.pdf",
      1000,
      true,
    );
    const previewToken = new URL(preview.url).searchParams.get("token");
    const openedPdf = await local.openDownload(previewToken, 2000);
    assert.equal(openedPdf.type, "application/pdf");
    assert.match(openedPdf.disposition, /^inline;/);
    const pdfChunks = [];
    for await (const chunk of openedPdf.stream) pdfChunks.push(chunk);
    assert.deepEqual(
      Buffer.concat(pdfChunks),
      require("./pdf-fixture.cjs").pdfFixture(),
    );
    await writeFile(source, "not a pdf");
    await local.importFile(source, "local/not-pdf");
    const fake = await local.download("local/not-pdf", "fake.pdf", 1000, true);
    await assert.rejects(
      local.openDownload(new URL(fake.url).searchParams.get("token"), 2000),
      (e) => e.getStatus() === 415,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T15 local rejects traversal and absolute OS paths for read/write/delete", async () => {
  const local = new LocalFileStorage({
    directory: join(tmpdir(), "streamora-safe-root"),
    secret: "secret",
    ttlSeconds: 120,
    baseUrl: "http://127.0.0.1:4000",
  });
  for (const key of [
    "../secret",
    "a/../../secret",
    "/absolute",
    "C:\\secret",
    "a\\..\\secret",
    "a//b",
    ".",
    "a/CON",
    "a/..",
    "a/file.",
  ]) {
    await assert.rejects(
      local.download(key, "name"),
      (e) => e.getStatus() === 400,
    );
    await assert.rejects(local.delete(key), (e) => e.getStatus() === 400);
    await assert.rejects(
      local.importFile("anywhere", key),
      (e) => e.getStatus() === 400,
    );
  }
});
