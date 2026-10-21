const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
const { createApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const { createTestDatabase } = require("./database-fixture.cjs");

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
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
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
    const admin = await registerAndLogin("admin@streamora.test", "Quản trị viên");
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
  const getRes1 = await api("GET", `/groups/${createdGroupId}`, { token: token1 });
  assert.equal(getRes1.status, 200);
  assert.equal(getRes1.body.group.id, createdGroupId);

  // User 2 (not a member) is rejected with 403 FORBIDDEN
  const getRes2 = await api("GET", `/groups/${createdGroupId}`, { token: token2 });
  assert.equal(getRes2.status, 403);
  assert.equal(getRes2.body.error.code, "FORBIDDEN");

  // Admin can view
  const getAdmin = await api("GET", `/groups/${createdGroupId}`, { token: adminToken });
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
  assert.equal(updateRes1.body.group.name, "Điện toán đám mây K69 (Đã cập nhật)");

  // 6. T02-05: Xóa mềm group
  // User 2 (non-owner) cannot delete -> 403 FORBIDDEN
  const deleteRes2 = await api("DELETE", `/groups/${createdGroupId}`, { token: token2 });
  assert.equal(deleteRes2.status, 403);

  // User 1 (owner) deletes group -> 204
  const deleteRes1 = await api("DELETE", `/groups/${createdGroupId}`, { token: token1 });
  assert.equal(deleteRes1.status, 204);

  // 7. Verify soft-delete behavior:
  // - Excluded from active list
  const listAfterDelete = await api("GET", "/groups", { token: token1 });
  assert.ok(!listAfterDelete.body.items.some((g) => g.id === createdGroupId));

  // - Direct GET returns 404 GROUP_NOT_FOUND
  const getAfterDelete = await api("GET", `/groups/${createdGroupId}`, { token: token1 });
  assert.equal(getAfterDelete.status, 404);
  assert.equal(getAfterDelete.body.error.code, "GROUP_NOT_FOUND");
});
