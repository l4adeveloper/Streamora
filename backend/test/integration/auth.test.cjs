const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const { createApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const { createTestDatabase } = require("./database-fixture.cjs");
const { AUTH_POLICY } = require("../../dist/config/auth-policy");

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "Test-only-password-123!";
const EMAIL = "primary@example.test";
let fixture, app, prisma, base, config, primary;

async function api(method, path, options = {}) {
  const headers = {};
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.Cookie = options.cookie;
  const response = await fetch(`${options.base ?? base}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
    setCookie: response.headers.get("set-cookie"),
    headers: response.headers,
  };
}

const registerBody = (email) => ({
  email,
  password: PASSWORD,
  fullName: "Kiểm thử tài khoản",
});
async function login(email = EMAIL) {
  const response = await api("POST", "/auth/login", {
    body: { email, password: PASSWORD },
  });
  assert.equal(response.status, 200);
  assert.ok(typeof response.body.accessToken === "string");
  assert.ok(typeof response.cookie === "string");
  return response;
}
function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.error.code, code);
  assert.match(response.body.requestId, /^[a-f0-9-]{36}$/);
  assert.ok(!("stack" in response.body));
}
function assertPublicUser(user) {
  assert.deepEqual(Object.keys(user).sort(), [
    "email",
    "fullName",
    "globalRole",
    "id",
  ]);
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
    const created = await api("POST", "/auth/register", {
      body: registerBody(EMAIL),
    });
    assert.equal(created.status, 201);
    primary = created.body.user;
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

test("register normalizes email/name and stores a salted Argon2id hash without leaking it", async () => {
  const response = await api("POST", "/auth/register", {
    body: {
      ...registerBody("  Normalized@Example.Test  "),
      fullName: "  Nguyễn Minh  ",
    },
  });
  assert.equal(response.status, 201);
  assertPublicUser(response.body.user);
  assert.equal(response.body.user.email, "normalized@example.test");
  assert.equal(response.body.user.fullName, "Nguyễn Minh");
  assert.equal(response.body.user.globalRole, "USER");
  assert.equal(response.setCookie, null);
  const saved = await prisma.user.findUnique({
    where: { id: response.body.user.id },
  });
  assert.ok(saved.passwordHash.startsWith("$argon2id$"));
  assert.ok(await argon2.verify(saved.passwordHash, PASSWORD));
  const first = await prisma.user.findUnique({ where: { id: primary.id } });
  assert.ok(
    saved.passwordHash !== first.passwordHash,
    "same password must receive different salts",
  );
});

test("concurrent normalized duplicate registrations return one success and EMAIL_EXISTS", async () => {
  const responses = await Promise.all([
    api("POST", "/auth/register", {
      body: registerBody("Duplicate@example.test"),
    }),
    api("POST", "/auth/register", {
      body: registerBody(" duplicate@EXAMPLE.test "),
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  expectError(
    responses.find((r) => r.status === 409),
    409,
    "EMAIL_EXISTS",
  );
  assert.equal(
    await prisma.user.count({ where: { email: "duplicate@example.test" } }),
    1,
  );
});

test("registration rejects invalid input and privilege fields", async () => {
  for (const body of [
    { ...registerBody("invalid@example.test"), email: "not-an-email" },
    { ...registerBody("invalid@example.test"), password: "short" },
    { ...registerBody("invalid@example.test"), password: "x".repeat(129) },
    { ...registerBody("invalid@example.test"), fullName: "   " },
    { ...registerBody("invalid@example.test"), globalRole: "ADMIN" },
    { ...registerBody("invalid@example.test"), email: ["array@example.test"] },
  ])
    expectError(
      await api("POST", "/auth/register", { body }),
      400,
      "VALIDATION_ERROR",
    );
  assert.equal(
    await prisma.user.count({ where: { email: "invalid@example.test" } }),
    0,
  );
});

test("login, private profile reads and name updates obey the API contract", async () => {
  expectError(
    await api("POST", "/auth/login", {
      body: { email: EMAIL, password: "incorrect" },
    }),
    401,
    "INVALID_CREDENTIALS",
  );
  expectError(
    await api("POST", "/auth/login", {
      body: { email: "missing@example.test", password: PASSWORD },
    }),
    401,
    "INVALID_CREDENTIALS",
  );
  const session = await login(" PRIMARY@example.test ");
  assertPublicUser(session.body.user);
  assert.equal(session.body.expiresIn, config.auth.accessTokenTtlSeconds);
  assert.match(session.setCookie, /HttpOnly/i);
  assert.match(session.setCookie, /Path=\/api\/v1\/auth/i);
  assert.match(session.setCookie, /SameSite=Lax/i);
  assert.equal(session.headers.get("cache-control"), "no-store");
  assert.ok(!("refreshToken" in session.body));
  expectError(await api("GET", "/users/me"), 401, "UNAUTHENTICATED");
  const me = await api("GET", "/users/me", { token: session.body.accessToken });
  assert.equal(me.status, 200);
  assertPublicUser(me.body.user);
  const updated = await api("PATCH", "/users/me", {
    token: session.body.accessToken,
    body: { fullName: "  Tên mới  " },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.fullName, "Tên mới");
  for (const field of ["globalRole", "email", "password"]) {
    expectError(
      await api("PATCH", "/users/me", {
        token: session.body.accessToken,
        body: { fullName: "Tên mới", [field]: "forbidden-value" },
      }),
      400,
      "VALIDATION_ERROR",
    );
  }
});

test("refresh rotates hashed tokens and keeps the original absolute expiry", async () => {
  const initial = await login();
  const claims = jwt.decode(initial.body.accessToken);
  const before = await prisma.authSession.findUnique({
    where: { id: claims.sid },
  });
  const refreshed = await api("POST", "/auth/refresh", {
    cookie: initial.cookie,
  });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(Object.keys(refreshed.body).sort(), [
    "accessToken",
    "expiresIn",
  ]);
  assert.ok(refreshed.cookie !== initial.cookie);
  assert.ok(refreshed.body.accessToken !== initial.body.accessToken);
  assert.equal(jwt.decode(refreshed.body.accessToken).sid, claims.sid);
  const history = await prisma.authRefreshToken.findMany({
    where: { sessionId: claims.sid },
    orderBy: { generation: "asc" },
  });
  assert.equal(history.length, 2);
  assert.ok(history[0].consumedAt);
  assert.equal(history[1].consumedAt, null);
  for (const record of history)
    assert.equal(record.expiresAt.getTime(), before.expiresAt.getTime());
  const raw = refreshed.cookie.split("=")[1];
  assert.ok(
    history[1].tokenHash === createHash("sha256").update(raw).digest("hex"),
  );
  assert.ok(history[1].tokenHash !== raw);
  assert.equal(
    (await api("GET", "/users/me", { token: refreshed.body.accessToken }))
      .status,
    200,
  );
});

test("reuse outside the recovery window commits family revocation", async () => {
  const initial = await login();
  const refreshed = await api("POST", "/auth/refresh", {
    cookie: initial.cookie,
  });
  assert.equal(refreshed.status, 200);
  await prisma.authRefreshToken.update({
    where: {
      tokenHash: createHash("sha256")
        .update(initial.cookie.split("=")[1])
        .digest("hex"),
    },
    data: {
      createdAt: new Date(
        Date.now() - AUTH_POLICY.refreshRecoveryWindowMs - 2000,
      ),
      consumedAt: new Date(
        Date.now() - AUTH_POLICY.refreshRecoveryWindowMs - 1000,
      ),
    },
  });
  const reused = await api("POST", "/auth/refresh", { cookie: initial.cookie });
  expectError(reused, 401, "REFRESH_REUSED");
  assert.match(reused.setCookie, /Expires=Thu, 01 Jan 1970/i);
  const session = await prisma.authSession.findUnique({
    where: { id: jwt.decode(initial.body.accessToken).sid },
  });
  assert.equal(session.revocationReason, "REFRESH_REUSED");
  expectError(
    await api("GET", "/users/me", { token: refreshed.body.accessToken }),
    401,
    "UNAUTHENTICATED",
  );
  expectError(
    await api("POST", "/auth/refresh", { cookie: refreshed.cookie }),
    401,
    "REFRESH_EXPIRED",
  );
});

test("logout revokes only its own session and is idempotent", async () => {
  const first = await login();
  const second = await login();
  const logout = await api("POST", "/auth/logout", { cookie: first.cookie });
  assert.equal(logout.status, 204);
  assert.equal(logout.body, null);
  assert.match(logout.setCookie, /Path=\/api\/v1\/auth/i);
  assert.match(logout.setCookie, /HttpOnly/i);
  expectError(
    await api("GET", "/users/me", { token: first.body.accessToken }),
    401,
    "UNAUTHENTICATED",
  );
  expectError(
    await api("POST", "/auth/refresh", { cookie: first.cookie }),
    401,
    "REFRESH_EXPIRED",
  );
  assert.equal(
    (await api("GET", "/users/me", { token: second.body.accessToken })).status,
    200,
  );
  assert.equal(
    (await api("POST", "/auth/logout", { cookie: first.cookie })).status,
    204,
  );
  assert.equal((await api("POST", "/auth/logout")).status, 204);
  assert.equal(
    (await api("POST", "/auth/logout", { cookie: "refreshToken=invalid" }))
      .status,
    204,
  );
});

test("disabled accounts cannot log in or use tokens and existing sessions stay revoked", async () => {
  const email = "disabled@example.test";
  const registration = await api("POST", "/auth/register", {
    body: registerBody(email),
  });
  assert.equal(registration.status, 201);
  const first = await login(email);
  const second = await login(email);
  const userId = registration.body.user.id;
  await prisma.user.update({
    where: { id: userId },
    data: { disabledAt: new Date() },
  });
  expectError(
    await api("GET", "/users/me", { token: first.body.accessToken }),
    403,
    "USER_DISABLED",
  );
  expectError(
    await api("POST", "/auth/refresh", { cookie: second.cookie }),
    403,
    "USER_DISABLED",
  );
  expectError(
    await api("POST", "/auth/login", { body: { email, password: PASSWORD } }),
    403,
    "USER_DISABLED",
  );
  assert.equal(
    await prisma.authSession.count({ where: { userId, revokedAt: null } }),
    0,
  );
  await prisma.user.update({
    where: { id: userId },
    data: { disabledAt: null },
  });
  expectError(
    await api("GET", "/users/me", { token: first.body.accessToken }),
    401,
    "UNAUTHENTICATED",
  );
});

test("expired sessions and malformed or missing refresh cookies are rejected", async () => {
  const initial = await login();
  await prisma.authSession.update({
    where: { id: jwt.decode(initial.body.accessToken).sid },
    data: {
      createdAt: new Date(Date.now() - 7200000),
      expiresAt: new Date(Date.now() - 3600000),
    },
  });
  expectError(
    await api("GET", "/users/me", { token: initial.body.accessToken }),
    401,
    "UNAUTHENTICATED",
  );
  expectError(
    await api("POST", "/auth/refresh", { cookie: initial.cookie }),
    401,
    "REFRESH_EXPIRED",
  );
  for (const cookie of [
    undefined,
    "refreshToken=invalid",
    `refreshToken=${randomBytes(32).toString("base64url")}`,
  ]) {
    expectError(
      await api("POST", "/auth/refresh", { cookie }),
      401,
      "REFRESH_EXPIRED",
    );
  }
  expectError(
    await api("POST", "/auth/refresh", {
      cookie: initial.cookie,
      body: { refreshToken: "not-accepted-in-body" },
    }),
    400,
    "VALIDATION_ERROR",
  );
});

test("concurrent refresh retries return the same cookie without branching or revocation", async () => {
  const initial = await login();
  const responses = await Promise.all([
    api("POST", "/auth/refresh", { cookie: initial.cookie }),
    api("POST", "/auth/refresh", { cookie: initial.cookie }),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.equal(responses[0].cookie, responses[1].cookie);
  for (const response of responses) {
    assert.equal(
      (await api("GET", "/users/me", { token: response.body.accessToken }))
        .status,
      200,
    );
  }
  assert.equal(
    await prisma.authRefreshToken.count({
      where: { sessionId: jwt.decode(initial.body.accessToken).sid },
    }),
    2,
  );
});

test("lost refresh responses recover across API instances without extending expiry or the retry window", async () => {
  const initial = await login();
  const sid = jwt.decode(initial.body.accessToken).sid;
  const rotated = await api("POST", "/auth/refresh", {
    cookie: initial.cookie,
  });
  const before = await prisma.authSession.findUnique({ where: { id: sid } });
  assert.ok(before.refreshRecoveryToken);
  assert.ok(
    !before.refreshRecoveryToken.includes(rotated.cookie.split("=")[1]),
  );
  const second = await createApplication(config);
  try {
    await second.listen(0, "127.0.0.1");
    const recovered = await api("POST", "/auth/refresh", {
      cookie: initial.cookie,
      base: await second.getUrl(),
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.cookie, rotated.cookie);
    const after = await prisma.authSession.findUnique({ where: { id: sid } });
    assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime());
    assert.equal(
      after.refreshRecoveryUntil.getTime(),
      before.refreshRecoveryUntil.getTime(),
    );
    assert.equal(after.revokedAt, null);
    assert.equal(
      await prisma.authRefreshToken.count({ where: { sessionId: sid } }),
      2,
    );
  } finally {
    await second.close();
  }
});

test("a recent ancestor recovers the current token after another tab rotates again", async () => {
  const initial = await login();
  const first = await api("POST", "/auth/refresh", { cookie: initial.cookie });
  const second = await api("POST", "/auth/refresh", { cookie: first.cookie });
  const recovered = await api("POST", "/auth/refresh", {
    cookie: initial.cookie,
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.cookie, second.cookie);
  assert.equal(
    await prisma.authRefreshToken.count({
      where: { sessionId: jwt.decode(initial.body.accessToken).sid },
    }),
    3,
  );
});

test("recovery never resurrects logout, disabled users or expired sessions", async () => {
  for (const reason of ["logout", "disabled", "expired"]) {
    const initial = await login();
    const rotated = await api("POST", "/auth/refresh", {
      cookie: initial.cookie,
    });
    const sid = jwt.decode(initial.body.accessToken).sid;
    try {
      if (reason === "logout")
        await api("POST", "/auth/logout", { cookie: rotated.cookie });
      if (reason === "disabled")
        await prisma.user.update({
          where: { id: primary.id },
          data: { disabledAt: new Date() },
        });
      if (reason === "expired")
        await prisma.authSession.update({
          where: { id: sid },
          data: {
            createdAt: new Date(Date.now() - 2000),
            expiresAt: new Date(Date.now() - 1000),
          },
        });
      const result = await api("POST", "/auth/refresh", {
        cookie: initial.cookie,
      });
      expectError(
        result,
        reason === "disabled" ? 403 : 401,
        reason === "disabled" ? "USER_DISABLED" : "REFRESH_EXPIRED",
      );
      if (reason !== "expired") {
        const saved = await prisma.authSession.findUnique({
          where: { id: sid },
        });
        assert.equal(saved.refreshRecoveryToken, null);
      }
    } finally {
      if (reason === "disabled")
        await prisma.user.update({
          where: { id: primary.id },
          data: { disabledAt: null },
        });
    }
  }
});

test("expired or corrupted recovery data cannot issue a refresh grant", async () => {
  for (const data of [
    { refreshRecoveryUntil: new Date(0) },
    { refreshRecoveryToken: "tampered-ciphertext" },
  ]) {
    const initial = await login();
    await api("POST", "/auth/refresh", { cookie: initial.cookie });
    const sid = jwt.decode(initial.body.accessToken).sid;
    await prisma.authSession.update({ where: { id: sid }, data });
    expectError(
      await api("POST", "/auth/refresh", { cookie: initial.cookie }),
      401,
      "REFRESH_REUSED",
    );
  }
});

test("cookie endpoints require the exact configured Origin", async () => {
  for (const path of ["register", "login", "refresh", "logout"]) {
    for (const origin of [
      null,
      "null",
      "https://untrusted.example",
      `${ORIGIN}.untrusted.example`,
      `${ORIGIN}/`,
    ]) {
      expectError(
        await api("POST", `/auth/${path}`, { origin, body: {} }),
        403,
        "ORIGIN_NOT_ALLOWED",
      );
    }
  }
});

test("the access guard rejects expired, forged and incomplete JWT claims", async () => {
  const initial = await login();
  const claims = jwt.decode(initial.body.accessToken);
  const common = { sub: primary.id, sid: claims.sid, jti: randomUUID() };
  const settings = {
    algorithm: "HS256",
    issuer: "streamora-api",
    audience: "streamora-web",
    expiresIn: 900,
  };
  const variants = [
    jwt.sign(common, randomBytes(48), settings),
    jwt.sign(common, config.auth.accessTokenSecret, {
      ...settings,
      algorithm: "HS384",
    }),
    jwt.sign(common, config.auth.accessTokenSecret, {
      ...settings,
      audience: "other-app",
    }),
    jwt.sign(common, config.auth.accessTokenSecret, {
      ...settings,
      issuer: "other-issuer",
    }),
    jwt.sign(common, config.auth.accessTokenSecret, {
      ...settings,
      expiresIn: -1,
    }),
    jwt.sign(
      { ...common, sid: "not-a-uuid" },
      config.auth.accessTokenSecret,
      settings,
    ),
    jwt.sign(
      { sub: primary.id, sid: claims.sid },
      config.auth.accessTokenSecret,
      settings,
    ),
    jwt.sign(common, config.auth.accessTokenSecret, {
      algorithm: "HS256",
      issuer: "streamora-api",
      audience: "streamora-web",
    }),
  ];
  for (const token of variants)
    expectError(
      await api("GET", "/users/me", { token }),
      401,
      "UNAUTHENTICATED",
    );
});

test("password whitespace and Unicode are preserved rather than normalized", async () => {
  const email = "unicode-password@example.test";
  const password = `  ${"😀".repeat(12)}  `;
  assert.equal(
    (
      await api("POST", "/auth/register", {
        body: { ...registerBody(email), password },
      })
    ).status,
    201,
  );
  assert.equal(
    (await api("POST", "/auth/login", { body: { email, password } })).status,
    200,
  );
  expectError(
    await api("POST", "/auth/login", {
      body: { email, password: password.trim() },
    }),
    401,
    "INVALID_CREDENTIALS",
  );
});

test("logout racing a refresh cannot leave a usable session", async () => {
  const initial = await login();
  const [refresh, logout] = await Promise.all([
    api("POST", "/auth/refresh", { cookie: initial.cookie }),
    api("POST", "/auth/logout", { cookie: initial.cookie }),
  ]);
  assert.equal(logout.status, 204);
  assert.ok([200, 401].includes(refresh.status));
  expectError(
    await api("GET", "/users/me", { token: initial.body.accessToken }),
    401,
    "UNAUTHENTICATED",
  );
  if (refresh.status === 200) {
    expectError(
      await api("GET", "/users/me", { token: refresh.body.accessToken }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await api("POST", "/auth/refresh", { cookie: refresh.cookie }),
      401,
      "REFRESH_EXPIRED",
    );
  }
  const session = await prisma.authSession.findUnique({
    where: { id: jwt.decode(initial.body.accessToken).sid },
  });
  assert.equal(session.revocationReason, "LOGOUT");
});

test("production cookie attributes and per-process login/register limits are applied", async () => {
  const secureOrigin = "https://streamora.example";
  const isolated = await createApplication({
    ...config,
    nodeEnv: "production",
    webOrigin: secureOrigin,
    auth: {
      ...config.auth,
      cookie: { ...config.auth.cookie, secure: true, sameSite: "none" },
    },
  });
  try {
    await isolated.listen(0, "127.0.0.1");
    const target = { base: await isolated.getUrl(), origin: secureOrigin };
    const loggedIn = await api("POST", "/auth/login", {
      ...target,
      body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(loggedIn.status, 200);
    assert.match(loggedIn.setCookie, /; Secure/i);
    assert.match(loggedIn.setCookie, /SameSite=None/i);
    for (let n = 0; n < 29; n++)
      assert.equal(
        (await api("POST", "/auth/login", { ...target, body: {} })).status,
        400,
      );
    const limited = await api("POST", "/auth/login", { ...target, body: {} });
    expectError(limited, 429, "RATE_LIMITED");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    for (let n = 0; n < 20; n++)
      assert.equal(
        (await api("POST", "/auth/register", { ...target, body: {} })).status,
        400,
      );
    expectError(
      await api("POST", "/auth/register", { ...target, body: {} }),
      429,
      "RATE_LIMITED",
    );
  } finally {
    await isolated.close();
  }
});
