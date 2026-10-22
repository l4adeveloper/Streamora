const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
const { createApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const { createTestDatabase } = require("./database-fixture.cjs");
const { GroupsService } = require("../../dist/modules/groups/groups.service");

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "Password123!@#";

let fixture, app, prisma, base, config;
let user1, token1;
let user2, token2;
let adminUser, adminToken;

async function api(method, path, options = {}) {
  const headers = {};
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey)
    headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await fetch(`${options.base ?? base}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    headers: response.headers,
  };
}

async function registerAndLogin(email, fullName) {
  await api("POST", "/auth/register", {
    body: { email, password: PASSWORD, fullName },
  });
  const loginRes = await api("POST", "/auth/login", {
    body: { email, password: PASSWORD },
  });
  return {
    user: loginRes.body.user,
    token: loginRes.body.accessToken,
  };
}

before(
  async () => {
    fixture = await createTestDatabase();
    config = {
      ...fixture.config,
      databaseUrl: fixture.url,
      webOrigin: ORIGIN,
      nodeEnv: "test",
      auth: {
        ...fixture.config.auth,
        accessTokenSecret: randomBytes(48).toString("base64url"),
        cookie: {
          ...fixture.config.auth.cookie,
          secure: false,
          sameSite: "lax",
        },
      },
    };
    prisma = new PrismaService(fixture.url);
    await prisma.onModuleInit();
    app = await createApplication(config);
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();

    // Create User 1
    const u1 = await registerAndLogin("user1@streamora.test", "Người dùng Một");
    user1 = u1.user;
    token1 = u1.token;

    // Create User 2
    const u2 = await registerAndLogin("user2@streamora.test", "Người dùng Hai");
    user2 = u2.user;
    token2 = u2.token;

    // Create Admin User
    const admin = await registerAndLogin(
      "admin@streamora.test",
      "Quản trị viên",
    );
    // Promote admin in DB
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { globalRole: "ADMIN" },
    });
    // Re-login to get admin token with ADMIN globalRole
    const adminLogin = await api("POST", "/auth/login", {
      body: { email: "admin@streamora.test", password: PASSWORD },
    });
    adminUser = adminLogin.body.user;
    adminToken = adminLogin.body.accessToken;
  },
  { timeout: 120000 },
);

after(async () => {
  try {
    if (app) await app.close();
    if (prisma) await prisma.onModuleDestroy();
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test("T02 E2E: Full lifecycle of group management and data isolation", async () => {
  let createdGroupId;

  // 1. T02-01: User 1 creates Group 1
  const createRes = await api("POST", "/groups", {
    token: token1,
    body: {
      name: "Điện toán đám mây K69",
      description: "Nhóm nghiên cứu học tập",
    },
  });
  assert.equal(createRes.status, 201);
  assert.ok(createRes.body.group.id);
  assert.equal(createRes.body.group.name, "Điện toán đám mây K69");
  assert.equal(createRes.body.group.ownerId, user1.id);
  createdGroupId = createRes.body.group.id;

  // Verify membership in DB
  const memberRecord = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId: user1.id, groupId: createdGroupId } },
  });
  assert.ok(memberRecord);
  assert.equal(memberRecord.role, "OWNER");

  // 2. T02-01: Idempotency-Key test
  const idemKey = `idem-${randomUUID()}`;
  const resIdem1 = await api("POST", "/groups", {
    token: token1,
    idempotencyKey: idemKey,
    body: { name: "Nhóm Idempotent" },
  });
  const resIdem2 = await api("POST", "/groups", {
    token: token1,
    idempotencyKey: idemKey,
    body: { name: "Nhóm Idempotent" },
  });
  assert.equal(resIdem1.status, 201);
  assert.equal(resIdem2.status, 201);
  assert.equal(resIdem1.body.group.id, resIdem2.body.group.id);

  // 3. T02-02: List groups & Data Isolation between User 1 and User 2
  const listUser1 = await api("GET", "/groups", { token: token1 });
  assert.equal(listUser1.status, 200);
  assert.ok(listUser1.body.items.some((g) => g.id === createdGroupId));

  const listUser2 = await api("GET", "/groups", { token: token2 });
  assert.equal(listUser2.status, 200);
  // User 2 should NOT see User 1's groups
  assert.ok(!listUser2.body.items.some((g) => g.id === createdGroupId));

  // Admin sees User 1's group
  const listAdmin = await api("GET", "/groups", { token: adminToken });
  assert.equal(listAdmin.status, 200);
  assert.ok(listAdmin.body.items.some((g) => g.id === createdGroupId));

  // 4. T02-03: Chi tiết group & Access Control
  // User 1 (member/owner) can view
  const getRes1 = await api("GET", `/groups/${createdGroupId}`, {
    token: token1,
  });
  assert.equal(getRes1.status, 200);
  assert.equal(getRes1.body.group.id, createdGroupId);

  // User 2 (not a member) is rejected with 403 FORBIDDEN
  const getRes2 = await api("GET", `/groups/${createdGroupId}`, {
    token: token2,
  });
  assert.equal(getRes2.status, 403);
  assert.equal(getRes2.body.error.code, "FORBIDDEN");

  // Admin can view
  const getAdmin = await api("GET", `/groups/${createdGroupId}`, {
    token: adminToken,
  });
  assert.equal(getAdmin.status, 200);

  // 5. T02-04: Sửa group & Permission check
  // User 2 (non-owner) cannot update -> 403 FORBIDDEN
  const updateRes2 = await api("PATCH", `/groups/${createdGroupId}`, {
    token: token2,
    body: { name: "Tên bị sửa trái phép" },
  });
  assert.equal(updateRes2.status, 403);

  // User 1 (owner) can update
  const updateRes1 = await api("PATCH", `/groups/${createdGroupId}`, {
    token: token1,
    body: { name: "Điện toán đám mây K69 (Đã cập nhật)" },
  });
  assert.equal(updateRes1.status, 200);
  assert.equal(
    updateRes1.body.group.name,
    "Điện toán đám mây K69 (Đã cập nhật)",
  );

  // 6. T02-05: Xóa mềm group
  // User 2 (non-owner) cannot delete -> 403 FORBIDDEN
  const deleteRes2 = await api("DELETE", `/groups/${createdGroupId}`, {
    token: token2,
  });
  assert.equal(deleteRes2.status, 403);

  // User 1 (owner) deletes group -> 204
  const deleteRes1 = await api("DELETE", `/groups/${createdGroupId}`, {
    token: token1,
  });
  assert.equal(deleteRes1.status, 204);

  // 7. Verify soft-delete behavior:
  // - Excluded from active list
  const listAfterDelete = await api("GET", "/groups", { token: token1 });
  assert.ok(!listAfterDelete.body.items.some((g) => g.id === createdGroupId));

  // - Direct GET returns 404 GROUP_NOT_FOUND
  const getAfterDelete = await api("GET", `/groups/${createdGroupId}`, {
    token: token1,
  });
  assert.equal(getAfterDelete.status, 404);
  assert.equal(getAfterDelete.body.error.code, "GROUP_NOT_FOUND");
});

test("create retries survive API instances and concurrent requests; changed bodies conflict", async () => {
  const second = await createApplication(config, { requestLog: () => {} });
  try {
    await second.listen(0, "127.0.0.1");
    const secondBase = await second.getUrl();
    const key = randomUUID();
    const options = {
      token: token1,
      idempotencyKey: key,
      body: { name: `Concurrent ${key}` },
    };
    const results = await Promise.all([
      api("POST", "/groups", options),
      api("POST", "/groups", { ...options, base: secondBase }),
      api("POST", "/groups", options),
    ]);
    for (const result of results) {
      assert.equal(result.status, 201);
      assert.equal(result.body.group.id, results[0].body.group.id);
    }
    assert.equal(
      await prisma.group.count({ where: { name: options.body.name } }),
      1,
    );
    const persisted = await new GroupsService(prisma).create(
      user1.id,
      options.body,
      key,
    );
    assert.deepEqual(persisted, results[0].body);

    const conflict = await api("POST", "/groups", {
      ...options,
      body: { name: "Different body" },
      base: secondBase,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
    const otherUser = await api("POST", "/groups", {
      ...options,
      token: token2,
    });
    assert.equal(otherUser.status, 201);
    assert.notEqual(otherUser.body.group.id, persisted.group.id);
    const invalidKey = await api("POST", "/groups", {
      ...options,
      idempotencyKey: "x".repeat(129),
    });
    assert.equal(invalidKey.status, 400);
  } finally {
    await second.close();
  }
});

test("group updates clear descriptions, reject null names and enforce owner/admin permissions", async () => {
  const created = await api("POST", "/groups", {
    token: token1,
    body: { name: "Permissions", description: "Old description" },
  });
  const id = created.body.group.id;
  for (const role of ["VIEWER", "HOST", "OWNER"]) {
    await prisma.groupMember.upsert({
      where: { userId_groupId: { userId: user2.id, groupId: id } },
      create: { userId: user2.id, groupId: id, role },
      update: { role },
    });
    assert.equal(
      (await api("GET", `/groups/${id}`, { token: token2 })).status,
      200,
    );
    assert.equal(
      (
        await api("PATCH", `/groups/${id}`, {
          token: token2,
          body: { name: "Denied" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await api("DELETE", `/groups/${id}`, { token: token2 })).status,
      403,
    );
  }
  const nullName = await api("PATCH", `/groups/${id}`, {
    token: token1,
    body: { name: null },
  });
  assert.equal(nullName.status, 400);
  assert.equal(nullName.body.error.code, "VALIDATION_ERROR");
  for (const description of ["", null]) {
    const updated = await api("PATCH", `/groups/${id}`, {
      token: token1,
      body: { description },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.group.description, description);
  }
  assert.equal(
    (
      await api("PATCH", `/groups/${id}`, {
        token: adminToken,
        body: { name: "Admin update" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await api("DELETE", `/groups/${id}`, { token: adminToken })).status,
    204,
  );
});

test("cursor pagination is stable for identical timestamps and rejects invalid cursor contents", async () => {
  const prefix = `Pagination-${randomUUID()}`;
  const timestamp = new Date("2026-10-01T00:00:00.000Z");
  for (let i = 0; i < 5; i++) {
    await prisma.group.create({
      data: {
        name: `${prefix}-${i}`,
        ownerId: user1.id,
        createdAt: timestamp,
        members: { create: { userId: user1.id, role: "OWNER" } },
      },
    });
  }
  const ids = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ q: prefix, limit: "2" });
    if (cursor) query.set("cursor", cursor);
    const result = await api("GET", `/groups?${query}`, { token: token1 });
    assert.equal(result.status, 200);
    ids.push(...result.body.items.map((group) => group.id));
    cursor = result.body.nextCursor;
    assert.ok(ids.length <= 5);
  } while (cursor);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  for (const value of [
    {},
    { createdAt: "bad", id: randomUUID() },
    { createdAt: timestamp.toISOString(), id: "bad" },
  ]) {
    const invalid = Buffer.from(JSON.stringify(value)).toString("base64url");
    const result = await api("GET", `/groups?cursor=${invalid}`, {
      token: token1,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_CURSOR");
  }
});

test("database rejects group owners and members that do not exist", async () => {
  await assert.rejects(
    prisma.group.create({ data: { name: "Orphan", ownerId: randomUUID() } }),
    (error) => error.code === "P2003",
  );
  const group = await prisma.group.create({
    data: { name: "Valid owner", ownerId: user1.id },
  });
  await assert.rejects(
    prisma.groupMember.create({
      data: { groupId: group.id, userId: randomUUID() },
    }),
    (error) => error.code === "P2003",
  );
});

test("active names are unique per owner for create and rename, ignoring case and extra spaces", async () => {
  const prefix = `Name-${randomUUID()}`;
  const name = `${prefix} Toán`;
  const variant = `  ${prefix.toUpperCase()}   TOÁN  `;
  const first = await api("POST", "/groups", { token: token1, body: { name } });
  assert.equal(first.status, 201);
  const duplicate = await api("POST", "/groups", {
    token: token1,
    body: { name: variant },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "GROUP_NAME_EXISTS");

  const other = await api("POST", "/groups", {
    token: token1,
    body: { name: `${prefix} Văn` },
  });
  const renamed = await api("PATCH", `/groups/${other.body.group.id}`, {
    token: token1,
    body: { name: variant },
  });
  assert.equal(renamed.status, 409);
  assert.equal(renamed.body.error.code, "GROUP_NAME_EXISTS");
  const adminRename = await api("PATCH", `/groups/${other.body.group.id}`, {
    token: adminToken,
    body: { name },
  });
  assert.equal(adminRename.status, 409);
  assert.equal(
    (
      await api("PATCH", `/groups/${first.body.group.id}`, {
        token: token1,
        body: { name: variant },
      })
    ).status,
    200,
  );
  assert.equal(
    (await api("POST", "/groups", { token: token2, body: { name } })).status,
    201,
  );
  assert.equal(
    (await api("DELETE", `/groups/${first.body.group.id}`, { token: token1 }))
      .status,
    204,
  );
  assert.equal(
    (await api("POST", "/groups", { token: token1, body: { name } })).status,
    201,
  );
});

test("concurrent creates and renames cannot claim the same owner/name", async () => {
  const name = `Concurrent-name-${randomUUID()}`;
  const created = await Promise.all(
    Array.from({ length: 3 }, () =>
      api("POST", "/groups", { token: token1, body: { name } }),
    ),
  );
  assert.deepEqual(
    created.map((result) => result.status).sort(),
    [201, 409, 409],
  );
  assert.equal(
    await prisma.group.count({ where: { ownerId: user1.id, name } }),
    1,
  );

  const groups = await Promise.all(
    [0, 1].map((i) =>
      api("POST", "/groups", { token: token1, body: { name: `${name}-${i}` } }),
    ),
  );
  const target = `${name}-renamed`;
  const renamed = await Promise.all(
    groups.map((result) =>
      api("PATCH", `/groups/${result.body.group.id}`, {
        token: token1,
        body: { name: target },
      }),
    ),
  );
  assert.deepEqual(renamed.map((result) => result.status).sort(), [200, 409]);

  // Old records may already contain repeated whitespace; they must also reserve the name.
  await prisma.group.create({
    data: { name: `${name}   Legacy`, ownerId: user1.id },
  });
  assert.equal(
    (
      await api("POST", "/groups", {
        token: token1,
        body: { name: `${name} Legacy` },
      })
    ).status,
    409,
  );
});
