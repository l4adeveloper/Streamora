const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID, createHash } = require("node:crypto");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createTestDatabase } = require("./database-fixture.cjs");
const { createApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const {
  AccessTokenService,
} = require("../../dist/modules/auth/access-token.service");
let fixture, app, db, base, directory, owner, other, group;
const partSize = 8 * 1024 ** 2;
async function actor() {
  const user = await db.user.create({
    data: {
      email: `${randomUUID()}@upload.test`,
      fullName: "Upload test",
      passwordHash: await require("argon2").hash("T16-test-password-123!"),
    },
  });
  const session = await db.authSession.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) },
  });
  return {
    id: user.id,
    token: app
      .get(AccessTokenService)
      .issue(user.id, session.id, 3600, new Date()),
  };
}
async function api(method, path, body, user = owner) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "upload-test",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}
function input(size = partSize + 19) {
  return {
    groupId: group.id,
    filename: "Bài học.pdf",
    size,
    mimeType: "application/pdf",
    fingerprint: "test-fingerprint",
    source: "DOCUMENT",
  };
}
async function create(size) {
  const response = await api("POST", "/uploads", input(size));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}
async function sign(id, numbers, user) {
  return api(
    "POST",
    `/uploads/${id}/parts/sign`,
    { partNumbers: numbers },
    user,
  );
}
async function put(id, number, bytes, user) {
  const signed = await sign(id, [number], user);
  assert.equal(signed.status, 200);
  const response = await fetch(signed.body.parts[0].url, {
    method: "PUT",
    body: bytes,
  });
  assert.equal(response.status, 200);
  return { partNumber: number, etag: response.headers.get("etag") };
}
before(
  async () => {
    fixture = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), "streamora-uploads-"));
    app = await createApplication(
      {
        ...fixture.config,
        databaseUrl: fixture.url,
        nodeEnv: "test",
        uploads: {
          maxSize: 2 * 1024 ** 3,
          partSize,
          ttlSeconds: 86400,
          localPort: 0,
        },
        files: {
          ...fixture.config.files,
          driver: "local",
          localDirectory: join(directory, "files"),
          publicBaseUrl: "http://127.0.0.1",
          cleanupEnabled: false,
        },
      },
      { requestLog: () => {} },
    );
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    // Signed download service reads this object by reference.
    const storage = app.get(
      require("../../dist/modules/files/file-storage.service")
        .FileStorageService,
    );
    storage.local.options.baseUrl = base;
    db = app.get(PrismaService);
    owner = await actor();
    other = await actor();
    group = await db.group.create({
      data: { name: "Multipart", ownerId: owner.id },
    });
  },
  { timeout: 120000 },
);
after(async () => {
  try {
    if (app) await app.close();
  } finally {
    if (fixture) await fixture.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test(
  "T16 policy, owner isolation, real parts, completion retry and checksum roundtrip",
  { timeout: 240000 },
  async () => {
    assert.equal(
      (await api("POST", "/uploads", { ...input(), objectKey: "forged" }))
        .status,
      400,
    );
    assert.equal((await api("POST", "/uploads", input(), other)).status, 403);
    assert.equal(
      (await api("POST", "/uploads", { ...input(), size: 2 * 1024 ** 3 + 1 }))
        .status,
      413,
    );
    assert.equal(
      (await api("POST", "/uploads", { ...input(), mimeType: "text/html" }))
        .status,
      415,
    );
    assert.equal(
      (
        await api("POST", "/uploads", {
          ...input(),
          source: "LOCAL_RECORDING",
          mimeType: "video/webm",
        })
      ).status,
      400,
    );
    const size = process.env.T16_LARGE === "1" ? 1024 ** 3 : partSize * 5 + 19;
    const session = await create(size),
      id = session.uploadId;
    assert.equal((await sign(id, [1], other)).status, 403);
    assert.equal((await sign(id, [session.totalParts + 1])).status, 400);
    assert.equal((await sign(id, [1, 1])).status, 400);
    const expected = createHash("sha256"),
      parts = [];
    for (let first = 1; first <= session.totalParts; first += 5) {
      const batch = [];
      for (
        let number = first;
        number < first + 5 && number <= session.totalParts;
        number++
      ) {
        const bytes = Buffer.alloc(
          Math.min(partSize, size - (number - 1) * partSize),
          number % 251,
        );
        expected.update(bytes);
        batch.push(put(id, number, bytes));
      }
      parts.push(...(await Promise.all(batch)));
    }
    const endpoint = `/uploads/${id}/complete`;
    assert.equal(
      (await api("POST", endpoint, { parts: parts.slice(1) })).status,
      409,
    );
    assert.equal(
      (
        await api("POST", endpoint, {
          parts: parts.map((p, i) => (i ? p : { ...p, etag: "forged" })),
        })
      ).status,
      409,
    );
    const [done, retry] = await Promise.all([
      api("POST", endpoint, { parts }),
      api("POST", endpoint, { parts }),
    ]);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(retry.status, 200);
    assert.equal(done.body.file.id, retry.body.file.id);
    assert.equal(done.body.file.status, "AVAILABLE");
    assert.equal(done.body.file.objectKey, undefined);
    assert.equal(done.body.file.storageLocationId, undefined);
    assert.equal((await api("DELETE", `/uploads/${id}`)).status, 409);
    const download = await api(
      "POST",
      `/files/${done.body.file.id}/download-url`,
      {},
    );
    const bytes = await fetch(download.body.url);
    assert.equal(bytes.status, 200);
    const hash = createHash("sha256");
    for await (const chunk of bytes.body) hash.update(chunk);
    assert.equal(hash.digest("hex"), expected.digest("hex"));
    console.log(
      `T16 roundtrip SHA-256 verified: ${size} bytes, ${session.totalParts} parts, concurrency 5`,
    );
  },
);

test("T16 abort is repeatable, closes signed URLs, expiry and membership revocation", async () => {
  const session = await create(20),
    id = session.uploadId;
  const signed = await sign(id, [1]);
  assert.equal(
    (await api("DELETE", `/uploads/${id}`, undefined, other)).status,
    403,
  );
  assert.equal((await api("DELETE", `/uploads/${id}`)).status, 204);
  assert.equal((await api("DELETE", `/uploads/${id}`)).status, 204);
  assert.equal(
    (
      await fetch(signed.body.parts[0].url, {
        method: "PUT",
        body: Buffer.alloc(20),
      })
    ).status,
    403,
  );
  assert.equal((await sign(id, [1])).status, 409);
  const expired = await create(20);
  await db.uploadSession.update({
    where: { id: expired.uploadId },
    data: { expiresAt: new Date(0) },
  });
  assert.equal((await sign(expired.uploadId, [1])).status, 410);
  assert.equal(
    (await api("DELETE", `/uploads/${expired.uploadId}`)).status,
    204,
  );
  await db.groupMember.create({
    data: { userId: other.id, groupId: group.id, role: "HOST" },
  });
  const member = await api("POST", "/uploads", input(20), other);
  assert.equal(member.status, 201);
  await db.groupMember.delete({
    where: { userId_groupId: { userId: other.id, groupId: group.id } },
  });
  assert.equal((await sign(member.body.uploadId, [1], other)).status, 403);
  assert.equal(
    (await api("DELETE", `/uploads/${member.body.uploadId}`, undefined, other))
      .status,
    204,
  );
});

test("T16 missing storage part, changed size, expired signatures and completion recovery", async () => {
  const session = await create(partSize + 1),
    id = session.uploadId;
  const first = await put(id, 1, Buffer.alloc(partSize));
  assert.equal(
    (
      await api("POST", `/uploads/${id}/complete`, {
        parts: [first, { partNumber: 2, etag: "invented" }],
      })
    ).status,
    409,
  );
  await api("DELETE", `/uploads/${id}`);
  const recovery = await create(20);
  const part = await put(recovery.uploadId, 1, Buffer.alloc(20, 7));
  const upload = await db.uploadSession.findUnique({
    where: { id: recovery.uploadId },
  });
  const storage = app.get(
    require("../../dist/modules/uploads/multipart-storage.service")
      .MultipartStorageService,
  );
  const actual = await storage.list(upload.objectKey, upload.storageId);
  await storage.complete(upload.objectKey, upload.storageId, actual);
  // A process may die while COMPLETING after publishing bytes, before committing the file row.
  await db.uploadSession.update({
    where: { id: recovery.uploadId },
    data: {
      status: "COMPLETING",
      operationToken: randomUUID(),
      operationUntil: new Date(0),
    },
  });
  const done = await api("POST", `/uploads/${recovery.uploadId}/complete`, {
    parts: [part],
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
});

test("T16 validates recording group and actual part sizes", async () => {
  const session = await db.classSession.create({
    data: {
      kind: "GROUP",
      groupId: group.id,
      createdById: owner.id,
      title: "Ghi cục bộ",
      joinCode: "T16RECORD001",
      scheduledAt: new Date(Date.now() + 3600000),
    },
  });
  const dto = {
    ...input(20),
    source: "LOCAL_RECORDING",
    mimeType: "video/webm",
    sessionId: session.id,
  };
  const created = await api("POST", "/uploads", dto);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const part = await put(created.body.uploadId, 1, Buffer.alloc(20));
  const done = await api("POST", `/uploads/${created.body.uploadId}/complete`, {
    parts: [part],
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.file.sessionId, session.id);
  assert.equal(done.body.file.source, "LOCAL_RECORDING");
  const anotherGroup = await db.group.create({
    data: { name: "Nhóm khác", ownerId: owner.id },
  });
  assert.equal(
    (await api("POST", "/uploads", { ...dto, groupId: anotherGroup.id }))
      .status,
    400,
  );
  const wrongSize = await create(20);
  const stored = await put(wrongSize.uploadId, 1, Buffer.alloc(20));
  await db.uploadSession.update({
    where: { id: wrongSize.uploadId },
    data: { size: 21n },
  });
  const mismatch = await api(
    "POST",
    `/uploads/${wrongSize.uploadId}/complete`,
    { parts: [stored] },
  );
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, "SIZE_MISMATCH");
  await api("DELETE", `/uploads/${wrongSize.uploadId}`);
});

test("T16 server quotas serialize concurrent reservations, release on abort/expiry and enforce group/byte limits", async () => {
  const { APP_CONFIG } = require("../../dist/config/configuration.module");
  const policy = app.get(APP_CONFIG).uploads;
  const original = { ...policy };
  const ids = [];
  const reserve = async (user = owner) => {
    const response = await api("POST", "/uploads", input(20), user);
    if (response.status === 201) ids.push({ id: response.body.uploadId, user });
    return response;
  };
  try {
    const responses = await Promise.all(
      Array.from({ length: 7 }, () => reserve()),
    );
    assert.equal(responses.filter((r) => r.status === 201).length, 4);
    assert.equal(
      responses.filter(
        (r) =>
          r.status === 429 && r.body.error.code === "UPLOAD_QUOTA_EXCEEDED",
      ).length,
      3,
    );
    const expired = ids.pop();
    await db.uploadSession.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(0) },
    });
    const {
      UploadsService,
    } = require("../../dist/modules/uploads/uploads.service");
    await app.get(UploadsService).cleanupExpired();
    assert.equal(
      (await db.uploadSession.findUnique({ where: { id: expired.id } })).status,
      "ABORTED",
    );
    assert.equal((await reserve()).status, 201);
    for (const upload of ids.splice(0))
      assert.equal(
        (await api("DELETE", `/uploads/${upload.id}`, undefined, upload.user))
          .status,
        204,
      );

    await db.groupMember.create({
      data: { userId: other.id, groupId: group.id, role: "HOST" },
    });
    policy.maxActivePerGroup = 2;
    assert.equal((await reserve()).status, 201);
    assert.equal((await reserve(other)).status, 201);
    assert.equal((await reserve()).status, 429);
    for (const upload of ids.splice(0))
      await api("DELETE", `/uploads/${upload.id}`, undefined, upload.user);

    policy.maxActivePerGroup = 32;
    policy.maxActiveBytesPerUser = 30;
    assert.equal((await reserve()).status, 201);
    assert.equal((await reserve()).status, 429);
    policy.maxActiveBytesPerGroup = 30;
    assert.equal((await reserve(other)).status, 429);
  } finally {
    for (const upload of ids)
      await api("DELETE", `/uploads/${upload.id}`, undefined, upload.user);
    for (const key of Object.keys(policy)) delete policy[key];
    Object.assign(policy, original);
    await db.groupMember.deleteMany({
      where: { groupId: group.id, userId: other.id },
    });
  }
});

// Hold real storage work at a gate, then attempt an unrelated mutation with a strict DB lock timeout.
async function withStorageGate(method, work) {
  const {
    MultipartStorageService,
  } = require("../../dist/modules/uploads/multipart-storage.service");
  const storage = app.get(MultipartStorageService),
    original = storage[method];
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  storage[method] = async function (...args) {
    entered();
    await gate;
    return original.apply(this, args);
  };
  try {
    await work(ready, release);
  } finally {
    release();
    storage[method] = original;
  }
}
async function mutateGroup(work = async () => {}) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
    await tx.$queryRaw`SELECT id FROM groups WHERE id = ${group.id}::uuid FOR UPDATE`;
    await work(tx);
  });
}

test("T16 slow storage create/sign/abort does not hold group locks", async () => {
  let id;
  await withStorageGate("create", async (ready, release) => {
    const pending = create(20);
    try {
      await ready;
      await mutateGroup();
    } finally {
      release();
    }
    id = (await pending).uploadId;
  });
  await withStorageGate("sign", async (ready, release) => {
    const pending = sign(id, [1]);
    try {
      await ready;
      await mutateGroup();
    } finally {
      release();
    }
    assert.equal((await pending).status, 200);
  });
  await withStorageGate("abort", async (ready, release) => {
    const pending = api("DELETE", `/uploads/${id}`);
    try {
      await ready;
      await mutateGroup();
    } finally {
      release();
    }
    assert.equal((await pending).status, 204);
  });
});

test("T16 slow complete releases locks and rechecks membership before publishing", async () => {
  await db.groupMember.create({
    data: { userId: other.id, groupId: group.id, role: "HOST" },
  });
  const created = await api("POST", "/uploads", input(20), other);
  const id = created.body.uploadId;
  const part = await put(id, 1, Buffer.alloc(20), other);
  try {
    await withStorageGate("complete", async (ready, release) => {
      const pending = api(
        "POST",
        `/uploads/${id}/complete`,
        { parts: [part] },
        other,
      );
      try {
        await ready;
        assert.equal(
          (await api("DELETE", `/uploads/${id}`, undefined, other)).body.error
            .code,
          "UPLOAD_BUSY",
        );
        await mutateGroup((tx) =>
          tx.groupMember.delete({
            where: { userId_groupId: { groupId: group.id, userId: other.id } },
          }),
        );
      } finally {
        release();
      }
      assert.equal((await pending).status, 403);
    });
    const upload = await db.uploadSession.findUnique({ where: { id } });
    assert.equal(upload.status, "ACTIVE");
    assert.equal(
      await db.libraryFile.count({ where: { objectKey: upload.objectKey } }),
      0,
    );
    assert.equal(
      (await api("DELETE", `/uploads/${id}`, undefined, other)).status,
      204,
    );
  } finally {
    await db.groupMember.deleteMany({
      where: { groupId: group.id, userId: other.id },
    });
  }
});

test("T16 completed and in-flight local files retain their location after changing the configured provider", async () => {
  const {
    FileStorageService,
  } = require("../../dist/modules/files/file-storage.service");
  const {
    StorageLocationsService,
  } = require("../../dist/modules/files/storage-locations.service");
  const {
    MultipartStorageService,
  } = require("../../dist/modules/uploads/multipart-storage.service");
  const { APP_CONFIG } = require("../../dist/config/configuration.module");
  const config = app.get(APP_CONFIG);
  const created = await create(20),
    id = created.uploadId;
  const part = await put(id, 1, Buffer.alloc(20, 5));
  const upload = await db.uploadSession.findUnique({ where: { id } });
  assert.match(upload.storageLocationId, /^[a-f0-9]{64}$/);
  // Read through a fresh registry (JSONB key order differs from the original JS object).
  const switchedConfig = {
    ...config,
    files: { ...config.files, driver: "s3", bucket: "future-bucket" },
  };
  const switched = new FileStorageService(
    switchedConfig,
    new StorageLocationsService(switchedConfig, db),
  );
  const multipart = new MultipartStorageService(switchedConfig, switched);
  const anotherConfig = {
    ...config,
    files: { ...config.files, localDirectory: join(directory, "new-files") },
  };
  const another = new FileStorageService(
    anotherConfig,
    new StorageLocationsService(anotherConfig, db),
  );
  try {
    const parts = await multipart.list(
      upload.objectKey,
      upload.storageId,
      upload.storageLocationId,
    );
    assert.equal(parts[0].etag, part.etag);
    await multipart.complete(
      upload.objectKey,
      upload.storageId,
      parts,
      upload.storageLocationId,
    );
    assert.equal(
      await switched.localSize(upload.objectKey, upload.storageLocationId),
      20,
    );
    const grant = await switched.download(
      upload.objectKey,
      "old.pdf",
      false,
      "application/pdf",
      upload.storageLocationId,
    );
    const opened = await switched.openLocalDownload(
      new URL(grant.url).searchParams.get("token"),
    );
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(20, 5));
    const location = await another.currentLocationId();
    const source = join(directory, "new-source");
    await writeFile(source, Buffer.alloc(8, 9));
    await another.importLocalFile(source, upload.objectKey, location);
    await switched.delete(upload.objectKey, upload.storageLocationId);
    assert.equal(await another.localSize(upload.objectKey, location), 8);
    await api("DELETE", `/uploads/${id}`);
  } finally {
    switched.onModuleDestroy();
    another.onModuleDestroy();
    await multipart.onModuleDestroy();
  }
});

test("T17 status uses storage parts, protects owner, supports resume and terminal/expiry states", async () => {
  const session = await create();
  const id = session.uploadId;
  assert.equal(
    (await api("GET", `/uploads/${id}`, undefined, other)).status,
    403,
  );
  const first = await put(id, 1, Buffer.alloc(partSize, 7));
  const snapshot = await api("GET", `/uploads/${id}`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.fingerprint, input().fingerprint);
  assert.deepEqual(snapshot.body.uploadedParts, [{ ...first, size: partSize }]);
  const second = await put(id, 2, Buffer.alloc(19, 8));
  const completed = await api("POST", `/uploads/${id}/complete`, {
    parts: [first, second],
  });
  assert.equal(completed.status, 200);
  const final = await api("GET", `/uploads/${id}`);
  assert.equal(final.body.status, "COMPLETED");
  assert.equal(final.body.fileId, completed.body.file.id);
  assert.deepEqual(final.body.uploadedParts, []);
  const aborted = await create(19);
  await api("DELETE", `/uploads/${aborted.uploadId}`);
  assert.equal(
    (await api("GET", `/uploads/${aborted.uploadId}`)).body.status,
    "ABORTED",
  );
  assert.equal(
    (
      await api("POST", `/uploads/${aborted.uploadId}/complete`, {
        parts: [first],
      })
    ).status,
    409,
  );
  const expired = await create(19);
  await db.uploadSession.update({
    where: { id: expired.uploadId },
    data: { expiresAt: new Date(0) },
  });
  assert.equal((await api("GET", `/uploads/${expired.uploadId}`)).status, 410);
  assert.equal((await sign(expired.uploadId, [1])).status, 410);
  assert.equal(
    (
      await api("POST", `/uploads/${expired.uploadId}/complete`, {
        parts: [first],
      })
    ).status,
    410,
  );
  const valid = await create(19);
  const {
    UploadsService,
  } = require("../../dist/modules/uploads/uploads.service");
  const result = await app
    .get(UploadsService)
    .cleanupExpired({ cutoffAt: new Date(Date.now() + 86400000), limit: 10 });
  assert.ok(result.aborted >= 1);
  assert.equal(result.failed, 0);
  assert.equal(
    (await api("GET", `/uploads/${expired.uploadId}`)).body.status,
    "ABORTED",
  );
  assert.equal(
    (await api("GET", `/uploads/${valid.uploadId}`)).body.status,
    "ACTIVE",
  );
  await api("DELETE", `/uploads/${valid.uploadId}`);
});

test("Viewer cannot create or resume uploads; demoted hosts can still abort their own upload", async () => {
  await db.groupMember.upsert({
    where: { userId_groupId: { userId: other.id, groupId: group.id } },
    create: { userId: other.id, groupId: group.id, role: "VIEWER" },
    update: { role: "VIEWER" },
  });
  assert.equal((await api("POST", "/uploads", input(19), other)).status, 403);
  await db.groupMember.update({
    where: { userId_groupId: { userId: other.id, groupId: group.id } },
    data: { role: "HOST" },
  });
  const session = await api("POST", "/uploads", input(19), other);
  assert.equal(session.status, 201);
  await db.groupMember.update({
    where: { userId_groupId: { userId: other.id, groupId: group.id } },
    data: { role: "VIEWER" },
  });
  assert.equal(
    (await api("GET", `/uploads/${session.body.uploadId}`, undefined, other))
      .status,
    403,
  );
  assert.equal((await sign(session.body.uploadId, [1], other)).status, 403);
  assert.equal(
    (
      await api(
        "POST",
        `/uploads/${session.body.uploadId}/complete`,
        { parts: [] },
        other,
      )
    ).status,
    403,
  );
  assert.equal(
    (await api("DELETE", `/uploads/${session.body.uploadId}`, undefined, other))
      .status,
    204,
  );
});
