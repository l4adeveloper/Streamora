const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../../dist/modules/app.module");
const { configureApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const {
  AccessTokenService,
} = require("../../dist/modules/auth/access-token.service");
const { createTestDatabase } = require("./database-fixture.cjs");
let fixture,
  prisma,
  app,
  second,
  base,
  otherBase,
  config,
  owner,
  host,
  viewer,
  viewer2,
  outsider,
  admin;
const origin = "http://127.0.0.1:3000";
const scheduledAt = "2026-10-25T19:00:00+07:00";

async function api(actor, method, path, body, { key, target = base } = {}) {
  const response = await fetch(`${target}/api/v1${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key !== undefined ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    headers: response.headers,
  };
}
function expect(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body.error.code, code);
  return result.body;
}
async function account(name, globalRole = "USER") {
  const user = await prisma.user.create({
    data: {
      email: `t04-${name}-${randomUUID()}@example.test`,
      fullName: name,
      passwordHash: "$argon2id$non-loginable-api-fixture",
      globalRole,
    },
  });
  const auth = await prisma.authSession.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) },
  });
  return {
    ...user,
    authSessionId: auth.id,
    token: app.get(AccessTokenService).issue(user.id, auth.id, 900, new Date()),
  };
}
async function group() {
  return prisma.group.create({
    data: {
      name: `T04 ${randomUUID()}`,
      ownerId: owner.id,
      members: {
        create: [
          { userId: owner.id, role: "OWNER" },
          { userId: host.id, role: "HOST" },
          { userId: viewer.id, role: "VIEWER" },
          { userId: viewer2.id, role: "VIEWER" },
        ],
      },
    },
  });
}
async function lesson(groupId, actor = owner, body = {}, options = {}) {
  return expect(
    await api(
      actor,
      "POST",
      `/groups/${groupId}/sessions`,
      { title: "Lớp T04", scheduledAt, ...body },
      options,
    ),
    201,
  ).session;
}
async function meet(actor = owner, body = {}, options = {}) {
  return expect(
    await api(actor, "POST", "/meets", { title: "Meet T04", ...body }, options),
    201,
  ).session;
}
async function boot() {
  const server = await NestFactory.create(AppModule.forRoot(config), {
    logger: false,
  });
  configureApplication(server, config, { requestLog: () => {} });
  await server.listen(0, "127.0.0.1");
  return server;
}
before(
  async () => {
    fixture = await createTestDatabase();
    prisma = new PrismaService(fixture.url);
    await prisma.onModuleInit();
    config = {
      ...fixture.config,
      databaseUrl: fixture.url,
      nodeEnv: "test",
      docsEnabled: true,
      webOrigin: origin,
      auth: {
        ...fixture.config.auth,
        accessTokenSecret: randomBytes(48).toString("base64url"),
      },
    };
    app = await boot();
    second = await boot();
    base = await app.getUrl();
    otherBase = await second.getUrl();
    [owner, host, viewer, viewer2, outsider, admin] = await Promise.all([
      account("owner"),
      account("host"),
      account("viewer"),
      account("viewer2"),
      account("outsider"),
      account("admin", "ADMIN"),
    ]);
  },
  { timeout: 120000 },
);
after(async () => {
  try {
    if (app) await app.close();
    if (second) await second.close();
    if (prisma) await prisma.onModuleDestroy();
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test("T04 group creation uses current HOST/OWNER/ADMIN rights and canonical UTC data", async () => {
  const g = await group();
  const session = await lesson(g.id, host, {
    title: "  Lớp mới  ",
    description: "  Nội dung  ",
  });
  assert.equal(session.kind, "GROUP");
  assert.equal(session.groupId, g.id);
  assert.equal(session.createdById, host.id);
  assert.equal(session.title, "Lớp mới");
  assert.equal(session.description, "Nội dung");
  assert.equal(session.scheduledAt, "2026-10-25T12:00:00.000Z");
  assert.equal(session.status, "SCHEDULED");
  assert.equal(session.startedAt, null);
  assert.match(session.joinCode, /^[A-Z0-9]{12}$/);
  await lesson(g.id, owner);
  await lesson(g.id, admin);
  for (const actor of [viewer, outsider])
    expect(
      await api(actor, "POST", `/groups/${g.id}/sessions`, {
        title: "No",
        scheduledAt,
      }),
      403,
    );
  expect(
    await api(null, "POST", `/groups/${g.id}/sessions`, {
      title: "No",
      scheduledAt,
    }),
    401,
  );
  expect(
    await api(owner, "POST", `/groups/${randomUUID()}/sessions`, {
      title: "No",
      scheduledAt,
    }),
    404,
    "GROUP_NOT_FOUND",
  );
  assert.equal(
    await prisma.groupRoom.count(),
    0,
    "T04 does not create LiveKit mappings",
  );
});

test("T04 HTTP validation rejects forged fields, malformed dates, action bodies and keys", async () => {
  const g = await group();
  for (const changes of [
    { status: "LIVE" },
    { createdById: outsider.id },
    { kind: "MEET" },
    { groupId: randomUUID() },
    { title: null },
    { title: " " },
    { scheduledAt: null },
    { scheduledAt: "2026-02-30T19:00:00Z" },
    { scheduledAt: "2026-10-25T19:00:00" },
  ]) {
    expect(
      await api(owner, "POST", `/groups/${g.id}/sessions`, {
        title: "No",
        scheduledAt,
        ...changes,
      }),
      400,
      "VALIDATION_ERROR",
    );
  }
  const s = await lesson(g.id);
  for (const body of [null, [], { status: "LIVE" }, { userId: owner.id }])
    expect(await api(owner, "POST", `/sessions/${s.id}/start`, body), 400);
  expect(
    await api(owner, "POST", `/sessions/${s.id}/start`, {}, { key: "bad key" }),
    400,
  );
  expect(await api(owner, "GET", "/sessions/not-a-uuid"), 400);
  expect(await api(owner, "GET", "/meets/bad-code"), 400);
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1e2",
    "status=live",
    "status=LIVE&status=ENDED",
    "groupId=forged",
  ])
    expect(await api(viewer, "GET", `/groups/${g.id}/sessions?${query}`), 400);
});

test("T04 group list paginates stable UTC schedules and binds cursors to group, user and filter", async () => {
  const g = await group(),
    other = await group();
  const sessions = [];
  for (let i = 0; i < 4; i++) sessions.push(await lesson(g.id));
  const first = expect(
    await api(viewer, "GET", `/groups/${g.id}/sessions?limit=2`),
    200,
  );
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const next = expect(
    await api(
      viewer,
      "GET",
      `/groups/${g.id}/sessions?limit=2&cursor=${first.nextCursor}`,
    ),
    200,
  );
  assert.equal(next.nextCursor, null);
  assert.deepEqual(
    [...first.items, ...next.items].map((x) => x.id),
    sessions.map((x) => x.id).sort(),
  );
  expect(
    await api(
      viewer,
      "GET",
      `/groups/${other.id}/sessions?cursor=${first.nextCursor}`,
    ),
    400,
    "INVALID_CURSOR",
  );
  expect(
    await api(
      host,
      "GET",
      `/groups/${g.id}/sessions?cursor=${first.nextCursor}`,
    ),
    400,
    "INVALID_CURSOR",
  );
  expect(
    await api(
      viewer,
      "GET",
      `/groups/${g.id}/sessions?status=LIVE&cursor=${first.nextCursor}`,
    ),
    400,
    "INVALID_CURSOR",
  );
  expect(
    await api(viewer, "GET", `/groups/${g.id}/sessions?cursor=garbage`),
    400,
    "INVALID_CURSOR",
  );
  expect(await api(outsider, "GET", `/groups/${g.id}/sessions`), 403);
  const empty = expect(
    await api(viewer, "GET", `/groups/${g.id}/sessions?status=LIVE`),
    200,
  );
  assert.equal(empty.items.length, 0);
});

test("T04 details resolve group access from the stored session and use no-store responses", async () => {
  const g = await group(),
    s = await lesson(g.id),
    other = await group();
  await prisma.groupMember.create({
    data: { groupId: other.id, userId: outsider.id, role: "HOST" },
  });
  const response = await api(viewer, "GET", `/sessions/${s.id}`);
  assert.equal(expect(response, 200).session.id, s.id);
  assert.equal(response.headers.get("cache-control"), "no-store");
  expect(
    await api(outsider, "GET", `/sessions/${s.id}?groupId=${other.id}`),
    403,
  );
  expect(await api(null, "GET", `/sessions/${s.id}`), 401);
  expect(
    await api(owner, "GET", `/sessions/${randomUUID()}`),
    404,
    "SESSION_NOT_FOUND",
  );
  expect(await api(viewer, "GET", `/meets/${s.joinCode}`), 404);
});

test("T04 only managers edit SCHEDULED sessions; group schedules cannot be cleared", async () => {
  const g = await group(),
    s = await lesson(g.id);
  expect(
    await api(viewer, "PATCH", `/sessions/${s.id}`, { title: "forged" }),
    403,
  );
  expect(
    await api(host, "PATCH", `/sessions/${s.id}`, {
      title: " Sửa ",
      description: "Mô tả",
    }),
    200,
  );
  const cleared = expect(
    await api(owner, "PATCH", `/sessions/${s.id}`, { description: null }),
    200,
  ).session;
  assert.equal(cleared.title, "Sửa");
  assert.equal(cleared.description, null);
  const unchanged = expect(
    await api(owner, "PATCH", `/sessions/${s.id}`, {}),
    200,
  ).session;
  assert.equal(unchanged.updatedAt, cleared.updatedAt);
  expect(
    await api(owner, "PATCH", `/sessions/${s.id}`, { scheduledAt: null }),
    400,
  );
  expect(
    await api(owner, "PATCH", `/sessions/${s.id}`, { groupId: randomUUID() }),
    400,
  );
  expect(await api(owner, "POST", `/sessions/${s.id}/start`, {}), 200);
  expect(
    await api(owner, "PATCH", `/sessions/${s.id}`, { title: "late" }),
    409,
    "SESSION_NOT_EDITABLE",
  );
});

test("T04 lifecycle enforces terminal states and never reopens on a replayed start key", async () => {
  const g = await group(),
    s = await lesson(g.id);
  expect(
    await api(owner, "POST", `/sessions/${s.id}/end`, {}),
    409,
    "INVALID_SESSION_STATE",
  );
  for (const actor of [viewer, outsider])
    expect(await api(actor, "POST", `/sessions/${s.id}/start`, {}), 403);
  const key = randomUUID();
  const started = expect(
    await api(host, "POST", `/sessions/${s.id}/start`, {}, { key }),
    200,
  ).session;
  assert.equal(started.status, "LIVE");
  assert.ok(started.startedAt);
  assert.equal(
    await prisma.classParticipation.count({ where: { sessionId: s.id } }),
    0,
  );
  assert.equal(
    expect(await api(owner, "POST", `/sessions/${s.id}/start`), 200).session
      .startedAt,
    started.startedAt,
  );
  expect(await api(owner, "POST", `/sessions/${s.id}/cancel`, {}), 409);
  const ended = expect(
    await api(owner, "POST", `/sessions/${s.id}/end`, {}),
    200,
  ).session;
  assert.equal(ended.status, "ENDED");
  assert.ok(ended.endedAt >= ended.startedAt);
  assert.equal(
    expect(await api(host, "POST", `/sessions/${s.id}/end`, {}), 200).session
      .endedAt,
    ended.endedAt,
  );
  expect(
    await api(host, "POST", `/sessions/${s.id}/start`, {}, { key }),
    409,
    "INVALID_SESSION_STATE",
  );
  expect(await api(owner, "PATCH", `/sessions/${s.id}`, {}), 409);
  const cancelled = await lesson(g.id);
  const result = expect(
    await api(owner, "POST", `/sessions/${cancelled.id}/cancel`, {}),
    200,
  ).session;
  assert.equal(result.status, "CANCELLED");
  assert.ok(result.cancelledAt);
  assert.equal(result.startedAt, null);
  assert.equal(
    expect(await api(host, "POST", `/sessions/${cancelled.id}/cancel`), 200)
      .session.cancelledAt,
    result.cancelledAt,
  );
  for (const action of ["start", "end"])
    expect(
      await api(owner, "POST", `/sessions/${cancelled.id}/${action}`, {}),
      409,
    );
  assert.equal(
    await prisma.classSessionEndEvent.count({
      where: { sessionId: cancelled.id },
    }),
    0,
  );
});

test("T04 concurrent creates across instances share one idempotent response and reject changed input", async () => {
  const g = await group(),
    key = randomUUID();
  const body = { title: "Idempotent", scheduledAt };
  const responses = await Promise.all([
    api(host, "POST", `/groups/${g.id}/sessions`, body, { key }),
    api(
      host,
      "POST",
      `/groups/${g.id}/sessions`,
      { ...body, scheduledAt: "2026-10-25T12:00:00.000Z" },
      { key, target: otherBase },
    ),
  ]);
  for (const response of responses) expect(response, 201);
  assert.deepEqual(responses[0].body, responses[1].body);
  assert.equal(
    await prisma.classSession.count({ where: { groupId: g.id } }),
    1,
  );
  expect(
    await api(
      host,
      "POST",
      `/groups/${g.id}/sessions`,
      { ...body, title: "changed" },
      { key },
    ),
    409,
    "IDEMPOTENCY_CONFLICT",
  );
  await prisma.groupMember.delete({
    where: { userId_groupId: { userId: host.id, groupId: g.id } },
  });
  expect(
    await api(host, "POST", `/groups/${g.id}/sessions`, body, { key }),
    403,
  );
});

test("T04 concurrent start/end has one timestamp and one durable end event and closes admission atomically", async () => {
  const g = await group(),
    s = await lesson(g.id);
  const starts = await Promise.all([
    api(owner, "POST", `/sessions/${s.id}/start`, {}, { key: randomUUID() }),
    api(
      host,
      "POST",
      `/sessions/${s.id}/start`,
      {},
      { key: randomUUID(), target: otherBase },
    ),
  ]);
  for (const response of starts) expect(response, 200);
  assert.equal(
    starts[0].body.session.startedAt,
    starts[1].body.session.startedAt,
  );
  const past = (offset) => new Date(Date.now() - offset);
  const accepted = await prisma.classJoinRequest.create({
    data: {
      sessionId: s.id,
      userId: viewer.id,
      status: "ACCEPTED",
      requestedAt: past(4000),
      decidedAt: past(3000),
      decidedById: owner.id,
    },
  });
  await prisma.classJoinRequest.create({
    data: { sessionId: s.id, userId: viewer2.id, requestedAt: past(2000) },
  });
  await prisma.classParticipation.create({
    data: {
      sessionId: s.id,
      userId: viewer.id,
      joinRequestId: accepted.id,
      joinedAt: past(1000),
      lastSeenAt: new Date(),
    },
  });
  const ends = await Promise.all([
    api(owner, "POST", `/sessions/${s.id}/end`, {}, { key: randomUUID() }),
    api(
      host,
      "POST",
      `/sessions/${s.id}/end`,
      {},
      { key: randomUUID(), target: otherBase },
    ),
  ]);
  for (const response of ends) expect(response, 200);
  assert.equal(ends[0].body.session.endedAt, ends[1].body.session.endedAt);
  const events = await prisma.classSessionEndEvent.findMany({
    where: { sessionId: s.id },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].endedAt.toISOString(), ends[0].body.session.endedAt);
  assert.equal(typeof events[0].version, "bigint");
  assert.equal(
    await prisma.classJoinRequest.count({
      where: { sessionId: s.id, status: "EXPIRED" },
    }),
    2,
  );
  const visit = await prisma.classParticipation.findFirstOrThrow({
    where: { sessionId: s.id },
  });
  assert.equal(visit.leaveReason, "SESSION_ENDED");
  assert.equal(visit.leftAt.toISOString(), ends[0].body.session.endedAt);
  const preserved = await prisma.classJoinRequest.findUniqueOrThrow({
    where: { id: accepted.id },
  });
  assert.equal(preserved.decidedById, owner.id);
  assert.equal(await prisma.groupRoom.count(), 0);
});

test("T04 edit/start and cancel/start races produce only valid serial outcomes", async () => {
  const g = await group(),
    s = await lesson(g.id);
  const [edit, start] = await Promise.all([
    api(owner, "PATCH", `/sessions/${s.id}`, { title: "Edited" }),
    api(host, "POST", `/sessions/${s.id}/start`, {}, { target: otherBase }),
  ]);
  expect(start, 200);
  assert.ok([200, 409].includes(edit.status));
  const current = expect(
    await api(viewer, "GET", `/sessions/${s.id}`),
    200,
  ).session;
  assert.equal(current.status, "LIVE");
  assert.equal(current.title, edit.status === 200 ? "Edited" : "Lớp T04");
  const next = await lesson(g.id);
  const results = await Promise.all([
    api(owner, "POST", `/sessions/${next.id}/cancel`, {}),
    api(host, "POST", `/sessions/${next.id}/start`, {}, { target: otherBase }),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
});

test("T04 group deletion blocks LIVE sessions and serializes with starting a class", async () => {
  const g = await group(),
    s = await lesson(g.id);
  expect(await api(host, "POST", `/sessions/${s.id}/start`, {}), 200);
  expect(await api(owner, "DELETE", `/groups/${g.id}`), 409, "ACTIVE_SESSION");
  expect(await api(admin, "DELETE", `/groups/${g.id}`), 409, "ACTIVE_SESSION");
  expect(await api(owner, "POST", `/sessions/${s.id}/end`, {}), 200);
  expect(await api(owner, "DELETE", `/groups/${g.id}`), 204);
  expect(await api(owner, "GET", `/sessions/${s.id}`), 404);
  for (let i = 0; i < 2; i++) {
    const target = await group(),
      pending = await lesson(target.id);
    const [removed, started] = await Promise.all([
      api(owner, "DELETE", `/groups/${target.id}`),
      api(
        host,
        "POST",
        `/sessions/${pending.id}/start`,
        {},
        { target: otherBase },
      ),
    ]);
    assert.ok(
      (removed.status === 204 && started.status === 404) ||
        (removed.status === 409 && started.status === 200),
      JSON.stringify({ removed, started }),
    );
    const stored = await prisma.classSession.findUniqueOrThrow({
      where: { id: pending.id },
      include: { group: true },
    });
    assert.ok(!(stored.status === "LIVE" && stored.group.deletedAt));
  }
});

test("T04 independent meet discovery is minimal and management belongs to creator/ADMIN", async () => {
  const key = randomUUID();
  const s = await meet(
    viewer,
    { description: "Private description", scheduledAt },
    { key },
  );
  const repeated = await meet(
    viewer,
    { description: "Private description", scheduledAt },
    { key, target: otherBase },
  );
  assert.equal(s.id, repeated.id);
  assert.equal(s.kind, "MEET");
  assert.equal(s.groupId, null);
  const preview = await api(outsider, "GET", `/meets/${s.joinCode}`);
  const minimal = expect(preview, 200).meet;
  assert.deepEqual(Object.keys(minimal).sort(), [
    "host",
    "id",
    "status",
    "title",
  ]);
  assert.deepEqual(Object.keys(minimal.host).sort(), ["fullName", "id"]);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  expect(await api(null, "GET", `/meets/${s.joinCode}`), 401);
  expect(await api(host, "GET", `/sessions/${s.id}`), 403);
  expect(await api(owner, "POST", `/sessions/${s.id}/start`, {}), 403);
  const updated = expect(
    await api(viewer, "PATCH", `/sessions/${s.id}`, {
      scheduledAt: null,
      description: null,
    }),
    200,
  ).session;
  assert.equal(updated.scheduledAt, null);
  expect(await api(admin, "POST", `/sessions/${s.id}/start`, {}), 200);
  const own = expect(await api(viewer, "GET", "/meets?limit=100"), 200).items;
  assert.ok(own.some((x) => x.id === s.id));
  assert.ok(own.every((x) => x.createdById === viewer.id));
  const adminMine = expect(await api(admin, "GET", "/meets"), 200).items;
  assert.ok(adminMine.every((x) => x.createdById === admin.id));
  expect(await api(host, "POST", `/sessions/${s.id}/end`, {}), 403);
  expect(await api(viewer, "POST", `/sessions/${s.id}/end`, {}), 200);
});

test("T04 rechecks role, account status and auth-session revocation on existing tokens", async () => {
  const g = await group(),
    s = await lesson(g.id);
  expect(
    await api(owner, "PATCH", `/groups/${g.id}/members/${host.id}`, {
      role: "VIEWER",
    }),
    200,
  );
  expect(await api(host, "POST", `/sessions/${s.id}/start`, {}), 403);
  expect(
    await api(owner, "DELETE", `/groups/${g.id}/members/${viewer.id}`),
    204,
  );
  expect(await api(viewer, "GET", `/sessions/${s.id}`), 403);
  const banned = await account("disabled");
  const independent = await meet(banned);
  await prisma.user.update({
    where: { id: banned.id },
    data: { disabledAt: new Date() },
  });
  expect(
    await api(banned, "POST", `/sessions/${independent.id}/start`, {}),
    403,
    "USER_DISABLED",
  );
  const loggedOut = await account("logged-out");
  await prisma.authSession.update({
    where: { id: loggedOut.authSessionId },
    data: { revokedAt: new Date(), revocationReason: "LOGOUT" },
  });
  expect(await api(loggedOut, "POST", "/meets", { title: "No" }), 401);
});

test("T04 Swagger is available independently and never exposes credentials or media fields", async () => {
  const response = await fetch(`${base}/api/v1/docs-sessions-json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const document = await response.json();
  assert.equal(Object.values(document.paths).flatMap(Object.values).length, 19);
  assert.ok(document.paths["/api/v1/groups/{groupId}/sessions"]);
  assert.doesNotMatch(
    JSON.stringify(document.components.schemas.ClassSessionDto),
    /password|token|livekit/i,
  );
});
