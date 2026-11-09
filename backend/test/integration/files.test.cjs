const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { createTestDatabase } = require("./database-fixture.cjs");
const { createApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const {
  AccessTokenService,
} = require("../../dist/modules/auth/access-token.service");
const { FilesService } = require("../../dist/modules/files/files.service");
const {
  FileStorageService,
} = require("../../dist/modules/files/file-storage.service");
const {
  FileCleanupService,
} = require("../../dist/modules/files/file-cleanup.service");
let fixture,
  app,
  db,
  base,
  owner,
  viewer,
  host,
  outsider,
  admin,
  group,
  otherGroup,
  files;
async function actor(label, globalRole = "USER") {
  const user = await db.user.create({
    data: {
      email: `${label}@t15.test`,
      fullName: label,
      passwordHash: await require("argon2").hash("T15-test-only-password!"),
      globalRole,
    },
  });
  const session = await db.authSession.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) },
  });
  return {
    ...user,
    token: app
      .get(AccessTokenService)
      .issue(user.id, session.id, 3600, new Date()),
  };
}
async function api(actor, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    headers: response.headers,
  };
}
async function file(data = {}) {
  return db.libraryFile.create({
    data: {
      groupId: group.id,
      name: "Bài giảng.pdf",
      objectKey: `test/${randomUUID()}`,
      size: 1024n,
      mimeType: "application/pdf",
      source: "DOCUMENT",
      status: "AVAILABLE",
      createdBy: owner.id,
      ...data,
    },
  });
}

test("T15 slow download signing releases group locks and rechecks revocation before returning the grant", async () => {
  const member = await actor("revoked-during-signing");
  await db.groupMember.create({
    data: { userId: member.id, groupId: group.id, role: "VIEWER" },
  });
  const target = await file();
  const storage = app.get(FileStorageService),
    original = storage.download;
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  storage.download = async () => {
    entered();
    await gate;
    return {
      url: "https://storage.test/grant",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
  };
  const pending = api(member, "POST", `/files/${target.id}/download-url`, {});
  try {
    await ready;
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
      await tx.$queryRaw`SELECT id FROM groups WHERE id = ${group.id}::uuid FOR UPDATE`;
      await tx.groupMember.delete({
        where: { userId_groupId: { userId: member.id, groupId: group.id } },
      });
    });
  } finally {
    release();
    storage.download = original;
  }
  const response = await pending;
  assert.equal(response.status, 403);
  assert.equal(response.body.url, undefined);
});
before(
  async () => {
    fixture = await createTestDatabase();
    app = await createApplication(
      {
        ...fixture.config,
        nodeEnv: "test",
        databaseUrl: fixture.url,
        docsEnabled: true,
        files: undefined,
      },
      { requestLog: () => {} },
    );
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    db = app.get(PrismaService);
    files = app.get(FilesService);
    owner = await actor("owner");
    viewer = await actor("viewer");
    host = await actor("host");
    outsider = await actor("outsider");
    admin = await actor("admin", "ADMIN");
    group = await db.group.create({
      data: { name: "T15 group", ownerId: owner.id },
    });
    otherGroup = await db.group.create({
      data: { name: "Other", ownerId: outsider.id },
    });
    await db.groupMember.createMany({
      data: [
        { groupId: group.id, userId: owner.id, role: "OWNER" },
        { groupId: group.id, userId: viewer.id, role: "VIEWER" },
        { groupId: group.id, userId: host.id, role: "HOST" },
      ],
    });
  },
  { timeout: 120000 },
);
after(async () => {
  try {
    if (app) await app.close();
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test("T15 local HTTP: import into a real group, download bytes without AWS, expiry and physical cleanup", async () => {
  const { createServer } = require("node:net");
  const {
    mkdtemp,
    mkdir,
    writeFile,
    readFile,
    rm,
  } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const {
    importLocalFile,
    importLocalFolder,
  } = require("../../scripts/import-local-file.cjs");
  const temp = await mkdtemp(join(tmpdir(), "streamora-t15-http-"));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const config = {
    ...fixture.config,
    nodeEnv: "test",
    databaseUrl: fixture.url,
    files: {
      driver: "local",
      localDirectory: join(temp, "objects"),
      publicBaseUrl: `http://127.0.0.1:${port}`,
      bucket: "",
      region: "ap-southeast-1",
      downloadTtlSeconds: 1,
      cleanupEnabled: false,
    },
  };
  let localApp;
  try {
    const source = join(temp, "lesson.txt"),
      bytes = Buffer.from("Nội dung T15 local\n".repeat(100));
    await writeFile(source, bytes);
    const imported = await importLocalFile(config, {
      group: group.id,
      email: owner.email,
      path: source,
    });
    await assert.rejects(
      importLocalFile(config, {
        group: group.id,
        email: outsider.email,
        path: source,
      }),
      (e) => e.getStatus() === 403,
    );
    localApp = await createApplication(config, { requestLog: () => {} });
    await localApp.listen(port, "127.0.0.1");
    const storage = localApp.get(FileStorageService);
    const localFiles = localApp.get(FilesService);
    const pdfPath = join(temp, "preview.pdf");
    await writeFile(pdfPath, require("../pdf-fixture.cjs").pdfFixture());
    const importedPdf = await importLocalFile(config, {
      group: group.id,
      email: owner.email,
      path: pdfPath,
    });
    const previewEndpoint = `${config.files.publicBaseUrl}/api/v1/files/${importedPdf.fileId}/preview-url`;
    assert.equal(
      (await fetch(previewEndpoint, { method: "POST" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(previewEndpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${outsider.token}` },
        })
      ).status,
      403,
    );
    const previewResponse = await fetch(previewEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(previewResponse.status, 200);
    const previewLink = await previewResponse.json();
    const pdfContent = await fetch(previewLink.url);
    assert.equal(pdfContent.status, 200);
    assert.equal(pdfContent.headers.get("content-type"), "application/pdf");
    assert.match(pdfContent.headers.get("content-disposition"), /^inline;/);
    assert.deepEqual(
      Buffer.from(await pdfContent.arrayBuffer()),
      require("../pdf-fixture.cjs").pdfFixture(),
    );
    await assert.rejects(
      localFiles.download(owner.id, imported.fileId, true),
      (e) => e.getStatus() === 415,
    );
    await db.libraryFile.update({
      where: { id: importedPdf.fileId },
      data: { status: "PENDING" },
    });
    await assert.rejects(
      localFiles.download(owner.id, importedPdf.fileId, true),
      (e) => e.getStatus() === 409,
    );
    await db.libraryFile.update({
      where: { id: importedPdf.fileId },
      data: { status: "AVAILABLE" },
    });
    const pdfDownload = await fetch(
      (await localFiles.download(owner.id, importedPdf.fileId)).url,
    );
    assert.match(
      pdfDownload.headers.get("content-disposition"),
      /^attachment;/,
    );
    await pdfDownload.arrayBuffer();
    const folder = join(temp, "input-folder");
    await mkdir(join(folder, "chapter"), { recursive: true });
    await writeFile(join(folder, "notes.txt"), "root notes");
    await writeFile(join(folder, "chapter", "notes.txt"), "chapter notes");
    const importedFolderFiles = [];
    const folderResult = await importLocalFolder(
      config,
      { group: group.id, email: owner.email, folder },
      (file) => importedFolderFiles.push(file),
    );
    assert.equal(folderResult.count, 2);
    assert.deepEqual(importedFolderFiles.map((file) => file.name).sort(), [
      "chapter/notes.txt",
      "notes.txt",
    ]);
    for (const entry of importedFolderFiles) {
      const link = await localFiles.download(owner.id, entry.fileId);
      const contents = await fetch(link.url);
      assert.equal(contents.status, 200);
      assert.equal(
        await contents.text(),
        entry.name.startsWith("chapter/") ? "chapter notes" : "root notes",
      );
    }
    const issued = await localFiles.download(owner.id, imported.fileId);
    assert.equal(issued.url.startsWith(config.files.publicBaseUrl), true);
    const response = await fetch(issued.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const modified = new URL(issued.url);
    modified.searchParams.set("token", "bad-token");
    assert.equal((await fetch(modified)).status, 403);
    assert.equal(
      (await fetch(`${config.files.publicBaseUrl}/api/v1/file-downloads/local`))
        .status,
      403,
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await fetch(issued.url)).status, 403);
    const fresh = await localFiles.download(owner.id, imported.fileId);
    const row = await db.libraryFile.findUnique({
      where: { id: imported.fileId },
    });
    await localFiles.remove(owner.id, imported.fileId);
    await assert.rejects(
      readFile(join(config.files.localDirectory, row.objectKey)),
      (e) => e.code === "ENOENT",
    );
    await localApp.get(FileCleanupService).tick();
    const deletion = await db.fileObjectDeletion.findUnique({
      where: { fileId: imported.fileId },
    });
    assert.ok(deletion.completedAt);
    await assert.rejects(
      readFile(join(config.files.localDirectory, row.objectKey)),
      (e) => e.code === "ENOENT",
    );
    assert.equal((await fetch(fresh.url)).status, 404);
    assert.deepEqual(await readFile(source), bytes);
  } finally {
    if (localApp) await localApp.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("T15 HTTP: group isolation, literal search, type filters, stable cursor and private metadata", async () => {
  await file({ name: "Giáo trình 100%.pdf" });
  await file({ name: "100_percent.pdf" });
  await file({
    name: "Giáo trình.mp4",
    mimeType: "video/mp4",
    source: "LOCAL_RECORDING",
  });
  await file({
    groupId: otherGroup.id,
    createdBy: outsider.id,
    name: "SECRET.pdf",
  });
  assert.equal(
    (await api(null, "GET", `/groups/${group.id}/files`)).status,
    401,
  );
  assert.equal(
    (await api(outsider, "GET", `/groups/${group.id}/files?q=`)).status,
    403,
  );
  const result = await api(
    viewer,
    "GET",
    `/groups/${group.id}/files?q=giáo&limit=1`,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.items.length, 1);
  assert.ok(result.body.nextCursor);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.equal("objectKey" in result.body.items[0], false);
  const next = await api(
    viewer,
    "GET",
    `/groups/${group.id}/files?q=giáo&limit=1&cursor=${result.body.nextCursor}`,
  );
  assert.notEqual(next.body.items[0].id, result.body.items[0].id);
  assert.equal(next.body.nextCursor, null);
  assert.equal(
    (
      await api(
        viewer,
        "GET",
        `/groups/${group.id}/files?q=other&cursor=${result.body.nextCursor}`,
      )
    ).status,
    400,
  );
  const percent = await api(viewer, "GET", `/groups/${group.id}/files?q=%25`);
  assert.equal(percent.body.items.length, 1);
  assert.equal(percent.body.items[0].name, "Giáo trình 100%.pdf");
  const videos = await api(
    viewer,
    "GET",
    `/groups/${group.id}/files?type=video`,
  );
  assert.equal(videos.body.items.length, 1);
  assert.equal(videos.body.items[0].source, "LOCAL_RECORDING");
  assert.equal(
    (await api(admin, "GET", `/groups/${group.id}/files`)).status,
    200,
  );
});
test("T15 HTTP: creator/host permissions, rename keeps key, references protect deletes", async () => {
  const row = await file();
  assert.equal(
    (await api(viewer, "PATCH", `/files/${row.id}`, { name: "Hijack" })).status,
    403,
  );
  assert.equal((await api(viewer, "DELETE", `/files/${row.id}`)).status, 403);
  assert.equal((await api(outsider, "GET", `/files/${row.id}`)).status, 403);
  assert.equal(
    (
      await api(owner, "PATCH", `/files/${row.id}`, {
        name: " ",
        objectKey: "other",
      })
    ).status,
    400,
  );
  const renamed = await api(host, "PATCH", `/files/${row.id}`, {
    name: "  Đổi tên.pdf  ",
  });
  assert.equal(renamed.body.file.name, "Đổi tên.pdf");
  assert.equal(
    (await db.libraryFile.findUnique({ where: { id: row.id } })).objectKey,
    row.objectKey,
  );
  await db.fileUsage.create({
    data: { fileId: row.id, reference: "pipeline:test" },
  });
  assert.equal(
    (await api(owner, "DELETE", `/files/${row.id}`)).body.error.code,
    "FILE_IN_USE",
  );
  await db.fileUsage.deleteMany({ where: { fileId: row.id } });
  assert.equal((await api(owner, "DELETE", `/files/${row.id}`)).status, 204);
  assert.ok(
    await db.fileObjectDeletion.findUnique({ where: { fileId: row.id } }),
  );
  assert.equal((await api(owner, "GET", `/files/${row.id}`)).status, 404);
  assert.equal(
    (await api(owner, "POST", `/files/${row.id}/download-url`, {})).status,
    404,
  );
  const mine = await file({ createdBy: viewer.id });
  assert.equal(
    (await api(viewer, "PATCH", `/files/${mine.id}`, { name: "Của tôi" }))
      .status,
    200,
  );
  assert.equal((await api(viewer, "DELETE", `/files/${mine.id}`)).status, 204);
});
test("T15 download gates readiness, absent storage, current membership and cleanup retry", async () => {
  const pending = await file({ status: "PENDING" });
  assert.equal(
    (await api(viewer, "POST", `/files/${pending.id}/download-url`, {})).body
      .error.code,
    "FILE_NOT_READY",
  );
  assert.equal(
    (await api(owner, "DELETE", `/files/${pending.id}`)).body.error.code,
    "FILE_IN_USE",
  );
  const ready = await file();
  assert.equal(
    (await api(viewer, "POST", `/files/${ready.id}/download-url`, {})).status,
    503,
  );
  const storage = app.get(FileStorageService);
  const original = storage.download;
  storage.download = async () => ({
    url: "https://example.test/signed",
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  assert.equal(
    (await api(viewer, "POST", `/files/${ready.id}/download-url`, {})).status,
    200,
  );
  await db.groupMember.delete({
    where: { userId_groupId: { userId: viewer.id, groupId: group.id } },
  });
  assert.equal(
    (await api(viewer, "POST", `/files/${ready.id}/download-url`, {})).status,
    403,
  );
  storage.download = original;
  let fails = true;
  const deletedKeys = [];
  storage.delete = async (key) => {
    if (fails) throw Error("storage offline");
    deletedKeys.push(key);
  };
  const worker = app.get(FileCleanupService);
  await worker.tick();
  assert.ok(
    await db.fileObjectDeletion.count({
      where: { completedAt: null, attempts: { gt: 0 } },
    }),
  );
  fails = false;
  await db.fileObjectDeletion.updateMany({
    where: { completedAt: null },
    data: { nextAttemptAt: new Date(0) },
  });
  await worker.tick();
  assert.equal(
    await db.fileObjectDeletion.count({ where: { completedAt: null } }),
    0,
  );
  assert.ok(deletedKeys.length);
});
test("T15 internal recording registration: group validation, concurrent dedup, no downgrade or rename loss", async () => {
  const session = await db.classSession.create({
    data: {
      groupId: group.id,
      createdById: owner.id,
      title: "Buổi học",
      kind: "GROUP",
      scheduledAt: new Date(Date.now() + 3600000),
      joinCode: "T15RECORD123",
    },
  });
  const recordingId = randomUUID();
  const input = {
    recordingId,
    groupId: group.id,
    sourceObjectKey: `recordings/${recordingId}.mp4`,
    size: 2048,
    mimeType: "video/mp4",
    status: "PENDING",
  };
  await assert.rejects(
    files.registerRecording(input),
    (e) => e.getResponse().error.code === "RECORDING_NOT_FOUND",
  );
  await db.recordingAsset.create({
    data: { id: recordingId, sessionId: session.id },
  });
  await assert.rejects(
    files.registerRecording({ ...input, groupId: otherGroup.id }),
    (e) => e.getResponse().error.code === "GROUP_MISMATCH",
  );
  const results = await Promise.all([
    files.registerRecording(input),
    files.registerRecording(input),
  ]);
  assert.equal(results[0].fileId, results[1].fileId);
  await files.rename(owner.id, results[0].fileId, "Tên tùy chỉnh.mp4");
  await files.registerRecording({ ...input, status: "AVAILABLE", size: 4096 });
  await files.registerRecording(input);
  const row = await db.libraryFile.findUnique({
    where: { id: results[0].fileId },
  });
  assert.equal(row.name, "Tên tùy chỉnh.mp4");
  assert.equal(row.status, "AVAILABLE");
  assert.equal(row.size, 4096n);
  assert.equal(row.createdBy, owner.id);
  assert.equal(row.sessionId, session.id);
  assert.equal(
    (await api(owner, "DELETE", `/files/${row.id}`)).body.error.code,
    "FILE_IN_USE",
  );
  const doc = (await api(null, "GET", "/docs-files-json")).body;
  assert.equal(
    Object.entries(doc.paths)
      .filter(([path]) => !path.includes("/uploads"))
      .flatMap(([, p]) => Object.keys(p))
      .filter((m) => ["get", "post", "patch", "delete"].includes(m)).length,
    7,
  );
});
