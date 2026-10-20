const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { createApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const { createTestDatabase } = require("./database-fixture.cjs");

let fixture;
let prisma;
let sql;

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

test("the relocated API serves versioned routes, validation and credentialed CORS", async () => {
  const origin = "http://127.0.0.1:3000";
  const app = await createApplication({
    ...fixture.config,
    webOrigin: origin,
    databaseUrl: fixture.url,
  });
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const health = await fetch(`${base}/api/v1/health`, {
      headers: { Origin: origin },
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    assert.equal(health.headers.get("access-control-allow-origin"), origin);
    assert.equal(
      health.headers.get("access-control-allow-credentials"),
      "true",
    );
    assert.equal((await fetch(`${base}/api/health`)).status, 404);

    const preflight = await fetch(`${base}/api/v1/users/me`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(
      preflight.headers.get("access-control-allow-methods"),
      /PATCH/,
    );
    assert.match(
      preflight.headers.get("access-control-allow-headers"),
      /Authorization/,
    );

    const foreignOrigin = "https://untrusted.example";
    const foreign = await fetch(`${base}/api/v1/health`, {
      headers: { Origin: foreignOrigin },
    });
    assert.notEqual(
      foreign.headers.get("access-control-allow-origin"),
      foreignOrigin,
    );

    const invalidRoom = await fetch(`${base}/api/v1/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nhóm học", unexpectedField: true }),
    });
    assert.equal(invalidRoom.status, 400);
    const create = await fetch(`${base}/api/v1/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nhóm học" }),
    });
    assert.equal(create.status, 201);
    const room = (await create.json()).data;
    assert.equal((await fetch(`${base}/api/v1/rooms/${room.id}`)).status, 200);
    assert.equal((await fetch(`${base}/api/v1/communities`)).status, 200);
    assert.equal((await fetch(`${base}/api/v1/files?q=slide`)).status, 200);
  } finally {
    await app.close();
  }
});

// Synthetic, non-loginable fixture. Authentication and real Argon2 hashing are step 3.
const fixturePasswordHash = "$argon2id$integration-test-fixture";
const newUser = (email) => ({
  email,
  fullName: "Kiểm thử T01",
  passwordHash: fixturePasswordHash,
});

test("a fresh database receives the complete auth migration", async () => {
  const result = await sql.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  assert.deepEqual(result.rows.map((row) => row.tablename).sort(), [
    "_prisma_migrations",
    "auth_refresh_tokens",
    "auth_sessions",
    "users",
  ]);
  const migrations = await sql.query(
    'SELECT finished_at FROM "_prisma_migrations"',
  );
  assert.equal(migrations.rowCount, 1);
  assert.ok(migrations.rows[0].finished_at);
});

test("concurrent inserts of the same email produce one user and a unique conflict", async () => {
  const email = "concurrent@example.test";
  const results = await Promise.allSettled([
    prisma.user.create({ data: newUser(email) }),
    prisma.user.create({ data: newUser(email) }),
  ]);
  const successful = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "P2002");
  assert.equal(await prisma.user.count({ where: { email } }), 1);
  assert.equal(successful[0].value.globalRole, "USER");
  assert.equal(successful[0].value.disabledAt, null);
});

test("database constraints reject unnormalized email and empty profile names", async () => {
  for (const email of ["MixedCase@example.test", " padded@example.test ", ""]) {
    await assert.rejects(
      sql.query(
        "INSERT INTO users (id,email,password_hash,full_name) VALUES ($1,$2,$3,$4)",
        [randomUUID(), email, fixturePasswordHash, "Test"],
      ),
      { code: "23514" },
    );
  }
  await assert.rejects(
    sql.query(
      "INSERT INTO users (id,email,password_hash,full_name) VALUES ($1,$2,$3,$4)",
      [randomUUID(), "empty-name@example.test", fixturePasswordHash, "   "],
    ),
    { code: "23514" },
  );
});

test("token history supports one current token per family, expiry and revocation", async () => {
  const user = await prisma.user.create({
    data: newUser("session@example.test"),
  });
  const expiresAt = new Date(Date.now() + 604800000);
  const session = await prisma.authSession.create({
    data: { userId: user.id, expiresAt },
  });
  const oldToken = await prisma.authRefreshToken.create({
    data: {
      sessionId: session.id,
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt,
    },
  });
  await assert.rejects(
    prisma.authRefreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: randomBytes(32).toString("hex"),
        generation: 1,
        expiresAt,
      },
    }),
    { code: "P2002" },
  );
  const next = await prisma.$transaction(async (tx) => {
    await tx.authRefreshToken.update({
      where: { id: oldToken.id },
      data: { consumedAt: new Date() },
    });
    return tx.authRefreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: randomBytes(32).toString("hex"),
        generation: 1,
        expiresAt,
      },
    });
  });
  assert.equal(
    await prisma.authRefreshToken.count({ where: { sessionId: session.id } }),
    2,
  );
  assert.ok(
    (await prisma.authRefreshToken.findUnique({ where: { id: oldToken.id } }))
      .consumedAt,
  );
  assert.equal(next.sessionId, session.id);
  await prisma.authSession.update({
    where: { id: session.id },
    data: {
      revokedAt: new Date(),
      revocationReason: "REFRESH_REUSED",
    },
  });
  assert.equal(
    (await prisma.authSession.findUnique({ where: { id: session.id } }))
      .revocationReason,
    "REFRESH_REUSED",
  );
  await assert.rejects(
    sql.query(
      "INSERT INTO auth_sessions (id,user_id,expires_at) VALUES ($1,$2,CURRENT_TIMESTAMP - INTERVAL '1 day')",
      [randomUUID(), user.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    sql.query(
      "INSERT INTO auth_refresh_tokens (id,session_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)",
      [randomUUID(), randomUUID(), randomBytes(32).toString("hex"), expiresAt],
    ),
    { code: "23503" },
  );
});
