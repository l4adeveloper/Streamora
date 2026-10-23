const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { PrismaService } = require("../../dist/database/prisma.service");
const { createTestDatabase } = require("./database-fixture.cjs");

let fixture, prisma, sql;
const at = (seconds = 0) => new Date(Date.UTC(2026, 9, 23, 12, 0, seconds));

before(
  async () => {
    fixture = await createTestDatabase();
    prisma = new PrismaService(fixture.url);
    sql = new Client({
      connectionString: fixture.url,
      connectionTimeoutMillis: 5000,
    });
    await prisma.onModuleInit();
    await sql.connect();
  },
  { timeout: 120000 },
);

after(async () => {
  try {
    if (prisma) await prisma.onModuleDestroy();
    if (sql) await sql.end();
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

// Only test-owned identifiers are interpolated; all row values are parameters.
async function insert(table, values) {
  assert.ok(
    ["class_sessions", "class_join_requests", "class_participations"].includes(
      table,
    ),
  );
  const columns = Object.keys(values);
  assert.ok(columns.every((column) => /^[a-z_]+$/.test(column)));
  const result = await sql.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(",")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`,
    Object.values(values),
  );
  return result.rows[0];
}

const sessionData = (ownerId, overrides = {}) => ({
  id: randomUUID(),
  kind: "MEET",
  created_by_id: ownerId,
  title: "T04 database fixture",
  join_code: randomBytes(6).toString("hex").toUpperCase(),
  ...overrides,
});

async function context() {
  const users = await Promise.all(
    ["owner", "guest"].map((name) =>
      prisma.user.create({
        data: {
          email: `t04-${name}-${randomUUID()}@example.test`,
          fullName: name,
          passwordHash: "$argon2id$non-loginable-database-fixture",
        },
      }),
    ),
  );
  const [owner, guest] = users;
  const session = await insert("class_sessions", sessionData(owner.id));
  return { owner, guest, session };
}

const requestData = (ctx, overrides = {}) => ({
  id: randomUUID(),
  session_id: ctx.session.id,
  user_id: ctx.guest.id,
  requested_at: at(),
  ...overrides,
});

const participationData = (ctx, overrides = {}) => ({
  id: randomUUID(),
  session_id: ctx.session.id,
  user_id: ctx.guest.id,
  joined_at: at(2),
  last_seen_at: at(2),
  ...overrides,
});

test("T04 migration separates group classes from independent meets and protects discovery codes", async () => {
  const ctx = await context();
  const group = await prisma.group.create({
    data: { name: "T04 group", ownerId: ctx.owner.id },
  });
  const groupSession = await insert(
    "class_sessions",
    sessionData(ctx.owner.id, {
      kind: "GROUP",
      group_id: group.id,
      scheduled_at: "2026-10-25T19:00:00+07:00",
    }),
  );
  const read = await prisma.classSession.findUniqueOrThrow({
    where: { id: groupSession.id },
    include: { group: true, createdBy: true },
  });
  assert.equal(read.group.id, group.id);
  assert.equal(read.createdBy.id, ctx.owner.id);
  assert.equal(read.scheduledAt.toISOString(), "2026-10-25T12:00:00.000Z");
  assert.equal(ctx.session.group_id, null);
  assert.equal(ctx.session.status, "SCHEDULED");

  for (const invalid of [
    { kind: "GROUP" },
    { kind: "GROUP", group_id: group.id },
    { kind: "GROUP", scheduled_at: at() },
    { kind: "MEET", group_id: group.id },
    { title: "   " },
    { join_code: "invalid-code" },
    { join_code: "ABC123" },
  ]) {
    await assert.rejects(
      insert("class_sessions", sessionData(ctx.owner.id, invalid)),
      { code: "23514" },
    );
  }
  await assert.rejects(
    insert(
      "class_sessions",
      sessionData(ctx.owner.id, {
        join_code: ctx.session.join_code,
      }),
    ),
    { code: "23505" },
  );
  await assert.rejects(
    insert(
      "class_sessions",
      sessionData(ctx.owner.id, {
        kind: "GROUP",
        group_id: randomUUID(),
        scheduled_at: at(),
      }),
    ),
    { code: "23503" },
  );
});

test("T04 lifecycle timestamps cannot contradict a session's current status", async () => {
  const { owner } = await context();
  for (const invalid of [
    { status: "LIVE" },
    { status: "SCHEDULED", started_at: at() },
    { status: "ENDED", ended_at: at(1) },
    { status: "ENDED", started_at: at(2), ended_at: at(1) },
    { status: "CANCELLED" },
    { status: "CANCELLED", cancelled_at: at(1), started_at: at() },
  ]) {
    await assert.rejects(
      insert("class_sessions", sessionData(owner.id, invalid)),
      { code: "23514" },
    );
  }
  for (const valid of [
    { status: "LIVE", started_at: at() },
    { status: "ENDED", started_at: at(), ended_at: at(1) },
    { status: "CANCELLED", cancelled_at: at(1) },
  ]) {
    assert.equal(
      (await insert("class_sessions", sessionData(owner.id, valid))).status,
      valid.status,
    );
  }
});

test("T04 concurrent requests have one current admission; expiry retains decisions and permits a new request", async () => {
  const ctx = await context();
  const results = await Promise.allSettled(
    [0, 1].map(() =>
      prisma.classJoinRequest.create({
        data: {
          sessionId: ctx.session.id,
          userId: ctx.guest.id,
          requestedAt: at(),
        },
      }),
    ),
  );
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "P2002");
  const current = fulfilled[0].value;
  await prisma.classJoinRequest.update({
    where: { id: current.id },
    data: { status: "ACCEPTED", decidedAt: at(1), decidedById: ctx.owner.id },
  });
  await assert.rejects(insert("class_join_requests", requestData(ctx)), {
    code: "23505",
  });
  await prisma.classJoinRequest.update({
    where: { id: current.id },
    data: { status: "EXPIRED", closedAt: at(3) },
  });
  const next = await insert(
    "class_join_requests",
    requestData(ctx, { requested_at: at(4) }),
  );
  assert.equal(next.status, "PENDING");
  const history = await prisma.classJoinRequest.findUniqueOrThrow({
    where: { id: current.id },
  });
  assert.equal(history.status, "EXPIRED");
  assert.equal(history.decidedById, ctx.owner.id);
  assert.equal(history.decidedAt.toISOString(), at(1).toISOString());
});

test("T04 request decisions require a reviewer, valid timestamps and a consistent closure", async () => {
  const ctx = await context();
  for (const invalid of [
    { status: "ACCEPTED" },
    { status: "ACCEPTED", decided_at: at(1) },
    { status: "ACCEPTED", decided_by_id: ctx.owner.id },
    { status: "REJECTED", decided_at: at(1), decided_by_id: ctx.owner.id },
    { status: "CANCELLED" },
    { status: "PENDING", closed_at: at(1) },
    { status: "ACCEPTED", decided_at: at(-1), decided_by_id: ctx.owner.id },
    { status: "REVOKED", closed_at: at(-1) },
    {
      status: "EXPIRED",
      decided_at: at(2),
      decided_by_id: ctx.owner.id,
      closed_at: at(1),
    },
  ]) {
    await assert.rejects(
      insert("class_join_requests", requestData(ctx, invalid)),
      { code: "23514" },
    );
  }
  const rejected = await insert(
    "class_join_requests",
    requestData(ctx, {
      status: "REJECTED",
      decided_at: at(1),
      decided_by_id: ctx.owner.id,
      closed_at: at(1),
    }),
  );
  const next = await insert(
    "class_join_requests",
    requestData(ctx, { requested_at: at(2) }),
  );
  assert.notEqual(next.id, rejected.id);
  await prisma.classJoinRequest.update({
    where: { id: next.id },
    data: { status: "CANCELLED", closedAt: at(3) },
  });
  const expired = await insert(
    "class_join_requests",
    requestData(ctx, {
      status: "EXPIRED",
      requested_at: at(4),
      closed_at: at(5),
    }),
  );
  assert.equal(expired.decided_by_id, null);
});

test("T04 attendance cannot use another user's or another session's admission", async () => {
  const ctx = await context();
  const request = await insert(
    "class_join_requests",
    requestData(ctx, {
      status: "ACCEPTED",
      decided_at: at(1),
      decided_by_id: ctx.owner.id,
    }),
  );
  const other = await insert("class_sessions", sessionData(ctx.owner.id));
  for (const invalid of [
    { user_id: ctx.owner.id },
    { session_id: other.id },
    { join_request_id: randomUUID() },
  ]) {
    await assert.rejects(
      insert(
        "class_participations",
        participationData(ctx, {
          join_request_id: request.id,
          ...invalid,
        }),
      ),
      { code: "23503" },
    );
  }
  const visit = await prisma.classParticipation.create({
    data: {
      sessionId: ctx.session.id,
      userId: ctx.guest.id,
      joinRequestId: request.id,
      joinedAt: at(2),
      lastSeenAt: at(2),
    },
    include: { joinRequest: true },
  });
  assert.equal(visit.joinRequest.id, request.id);
  assert.equal(visit.leftAt, null);
});

test("T04 concurrent entries count one person while preserving later visits", async () => {
  const ctx = await context();
  const data = {
    sessionId: ctx.session.id,
    userId: ctx.owner.id,
    joinedAt: at(2),
    lastSeenAt: at(2),
  };
  const results = await Promise.allSettled(
    [0, 1].map(() => prisma.classParticipation.create({ data })),
  );
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "P2002");
  await prisma.classParticipation.update({
    where: { id: fulfilled[0].value.id },
    data: { leftAt: at(3), leaveReason: "LEFT" },
  });
  const next = await prisma.classParticipation.create({
    data: { ...data, joinedAt: at(4), lastSeenAt: at(4) },
  });
  assert.notEqual(next.id, fulfilled[0].value.id);
  assert.equal(
    await prisma.classParticipation.count({
      where: { sessionId: ctx.session.id, userId: ctx.owner.id },
    }),
    2,
  );
  assert.equal(
    await prisma.classParticipation.count({
      where: { sessionId: ctx.session.id, leftAt: null },
    }),
    1,
  );
});

test("T04 attendance requires a valid leave reason and cannot reuse an admission for a later visit", async () => {
  const ctx = await context();
  for (const invalid of [
    { left_at: at(3) },
    { leave_reason: "LEFT" },
    { left_at: at(1), leave_reason: "LEFT" },
    { last_seen_at: at(1) },
  ]) {
    await assert.rejects(
      insert("class_participations", participationData(ctx, invalid)),
      { code: "23514" },
    );
  }
  const request = await insert(
    "class_join_requests",
    requestData(ctx, {
      status: "ACCEPTED",
      decided_at: at(1),
      decided_by_id: ctx.owner.id,
    }),
  );
  await insert(
    "class_participations",
    participationData(ctx, {
      join_request_id: request.id,
      left_at: at(3),
      leave_reason: "LEFT",
    }),
  );
  await assert.rejects(
    insert(
      "class_participations",
      participationData(ctx, {
        join_request_id: request.id,
        joined_at: at(4),
        last_seen_at: at(4),
      }),
    ),
    { code: "23505" },
  );
});

test("T04 history survives soft group deletion and restricts hard deletion of referenced sessions", async () => {
  const ctx = await context();
  const group = await prisma.group.create({
    data: { name: "T04 history", ownerId: ctx.owner.id },
  });
  const session = await insert(
    "class_sessions",
    sessionData(ctx.owner.id, {
      kind: "GROUP",
      group_id: group.id,
      scheduled_at: at(),
    }),
  );
  await prisma.group.update({
    where: { id: group.id },
    data: { deletedAt: at() },
  });
  assert.equal(
    (await prisma.classSession.findUniqueOrThrow({ where: { id: session.id } }))
      .groupId,
    group.id,
  );
  await assert.rejects(
    sql.query("DELETE FROM groups WHERE id = $1", [group.id]),
    { code: "23503" },
  );
  await insert(
    "class_join_requests",
    requestData(ctx, {
      status: "CANCELLED",
      closed_at: at(1),
    }),
  );
  await assert.rejects(
    sql.query("DELETE FROM class_sessions WHERE id = $1", [ctx.session.id]),
    { code: "23503" },
  );
});
