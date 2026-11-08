const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UploadsService } = require("../dist/modules/uploads/uploads.service");
function fixture(storage = {}) {
  let upload = {
    id: "upload",
    userId: "owner",
    groupId: "group",
    status: "ACTIVE",
    filename: "file.pdf",
    size: 9n,
    fingerprint: "content-hash",
    partSize: 8,
    totalParts: 2,
    expiresAt: new Date(Date.now() + 60000),
    storageId: "storage",
    objectKey: "key",
    storageLocationId: "original-location",
  };
  const service = new UploadsService({}, {}, storage, {}, {});
  service.locked = async (user, id, work) => work(upload);
  return { service, set: (changes) => (upload = { ...upload, ...changes }) };
}
test("T17 status returns actual storage parts and original location; terminal states avoid storage", async () => {
  let calls = 0;
  const parts = [{ partNumber: 1, etag: "actual-etag", size: 8 }];
  const { service, set } = fixture({
    list: async (...args) => {
      calls++;
      assert.deepEqual(args, ["key", "storage", "original-location"]);
      return parts;
    },
  });
  const active = await service.status("owner", "upload");
  assert.deepEqual(active.uploadedParts, parts);
  assert.equal(active.size, 9);
  set({ status: "ABORTED", expiresAt: new Date(0) });
  assert.equal((await service.status("owner", "upload")).status, "ABORTED");
  set({ status: "COMPLETED", fileId: "single-file" });
  assert.equal((await service.status("owner", "upload")).fileId, "single-file");
  assert.equal(calls, 1);
  set({ status: "ACTIVE" });
  await assert.rejects(
    service.status("owner", "upload"),
    (error) => error.getStatus() === 410,
  );
});
test("T17 status recovers lost storage completion, reports unavailable storage and rechecks concurrent abort", async () => {
  const missing = Object.assign(new Error("missing"), { name: "NoSuchUpload" });
  const { service } = fixture({
    list: async () => {
      throw missing;
    },
    size: async () => 9,
  });
  assert.equal((await service.status("owner", "upload")).objectReady, true);
  const unavailable = fixture({
    list: async () => {
      throw new Error("storage offline");
    },
  });
  await assert.rejects(
    unavailable.service.status("owner", "upload"),
    (error) => error.getStatus() === 503,
  );
  const raced = fixture({
    list: async () => {
      raced.set({ status: "ABORTED" });
      throw missing;
    },
  });
  assert.equal(
    (await raced.service.status("owner", "upload")).status,
    "ABORTED",
  );
});
test("T17 cleanup isolates failed items, bounds future cutoff, returns batch counts and validates inputs", async () => {
  let claimed = 0;
  const db = {
    $queryRaw: async (sql, token, cutoff) => {
      assert.ok(sql.join("?").includes("FOR UPDATE SKIP LOCKED"));
      assert.ok(cutoff.getTime() <= Date.now());
      return claimed++ < 2 ? [{ id: String(claimed) }] : [];
    },
    uploadSession: { findUnique: async ({ where }) => ({ id: where.id }) },
  };
  const service = new UploadsService(db, {}, {}, {}, {});
  service.finishAbort = async (upload) => {
    if (upload.id === "1") throw new Error("offline");
  };
  assert.deepEqual(
    await service.cleanupExpired({
      cutoffAt: new Date(Date.now() + 86400000),
      limit: 5,
    }),
    { scanned: 2, aborted: 1, failed: 1 },
  );
  assert.throws(() => service.cleanupExpired({ limit: NaN }), RangeError);
});
