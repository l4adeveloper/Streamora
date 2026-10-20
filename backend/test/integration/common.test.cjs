const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
require("reflect-metadata");
const {
  Controller,
  Get,
  Delete,
  HttpCode,
  Param,
  Query,
  Module,
  ForbiddenException,
  ServiceUnavailableException,
} = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../../dist/modules/app.module");
const { configureApplication } = require("../../dist/app");
const {
  SessionSecurityModule,
} = require("../../dist/modules/auth/session-security.module");
const {
  RequireAuth,
  CurrentAuth,
  PaginationQueryDto,
  UUIDParamPipe,
} = require("../../dist/common");
const { createTestDatabase } = require("./database-fixture.cjs");

const PRIVATE = "sensitive-input-never-log-this";
const ORIGIN = "http://127.0.0.1:3000";
const logs = [];
let app, fixture, base;

// A separate feature module exercises the same public building blocks teammates use.
class FeatureController {
  protected(identity) {
    return { user: identity.user };
  }
  missingGuard(identity) {
    return identity;
  }
  list(query) {
    return { items: [query], nextCursor: null };
  }
  item(id) {
    return { id };
  }
  forbidden() {
    throw new ForbiddenException({ message: PRIVATE, token: PRIVATE });
  }
  unavailable() {
    throw new ServiceUnavailableException(PRIVATE);
  }
  unexpected() {
    throw new Error(PRIVATE);
  }
  remove() {}
}
Controller("shared-test")(FeatureController);
function decorate(name, ...decorators) {
  for (const decorator of decorators)
    decorator(
      FeatureController.prototype,
      name,
      Object.getOwnPropertyDescriptor(FeatureController.prototype, name),
    );
}
decorate("protected", Get("protected"), RequireAuth());
CurrentAuth()(FeatureController.prototype, "protected", 0);
decorate("missingGuard", Get("missing-guard"));
CurrentAuth()(FeatureController.prototype, "missingGuard", 0);
decorate("list", Get("list"));
Reflect.defineMetadata(
  "design:paramtypes",
  [PaginationQueryDto],
  FeatureController.prototype,
  "list",
);
Query()(FeatureController.prototype, "list", 0);
decorate("item", Get("items/:id"));
Param("id", new UUIDParamPipe())(FeatureController.prototype, "item", 0);
decorate("forbidden", Get("forbidden"));
decorate("unavailable", Get("unavailable"));
decorate("unexpected", Get("unexpected"));
decorate("remove", Delete("empty"), HttpCode(204));
class FeatureModule {}
Module({ imports: [SessionSecurityModule], controllers: [FeatureController] })(
  FeatureModule,
);

async function api(path, options = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: options.method ?? "GET",
    headers: { Origin: ORIGIN, ...options.headers },
    body: options.body,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text ? JSON.parse(text) : null,
  };
}
function expectError(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.body.error.code, code);
  assert.equal(result.body.requestId, result.headers.get("x-request-id"));
  assert.match(result.body.requestId, /^[a-f0-9-]{36}$/);
  assert.ok(!result.text.includes(PRIVATE));
}

before(
  async () => {
    fixture = await createTestDatabase();
    const config = {
      ...fixture.config,
      databaseUrl: fixture.url,
      nodeEnv: "test",
      webOrigin: ORIGIN,
      auth: {
        ...fixture.config.auth,
        accessTokenSecret: randomBytes(48).toString("base64url"),
      },
    };
    class TestRoot {}
    Module({ imports: [AppModule.forRoot(config), FeatureModule] })(TestRoot);
    app = await NestFactory.create(TestRoot, { logger: false });
    configureApplication(app, config, {
      requestLog: (entry) => logs.push(entry),
    });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
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

test("request IDs correlate errors and logs, while success/204 bodies retain their API shape", async () => {
  const response = await api("/health", {
    headers: { "X-Request-ID": PRIVATE },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.ok(!("data" in response.body));
  assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
  assert.ok(
    logs.some(
      (entry) =>
        entry.requestId === response.headers.get("x-request-id") &&
        entry.statusCode === 200,
    ),
  );
  const empty = await api("/shared-test/empty", { method: "DELETE" });
  assert.equal(empty.status, 204);
  assert.equal(empty.text, "");
  const missing = await api(`/unknown/${PRIVATE}?token=${PRIVATE}`);
  expectError(missing, 404, "NOT_FOUND");
  assert.ok(
    logs.some(
      (entry) =>
        entry.requestId === missing.body.requestId &&
        entry.route === "[unmatched]",
    ),
  );
});

test("global validation gives safe field details for DTOs and malformed JSON", async () => {
  const invalid = await api("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: PRIVATE,
      password: PRIVATE,
      fullName: "",
      [PRIVATE]: PRIVATE,
    }),
  });
  expectError(invalid, 400, "VALIDATION_ERROR");
  assert.ok(
    invalid.body.error.details.fields.some(
      (field) => field.field === "email" && field.code === "INVALID_EMAIL",
    ),
  );
  assert.ok(
    invalid.body.error.details.fields.some(
      (field) => field.field === "_form" && field.code === "UNEXPECTED_FIELD",
    ),
  );
  expectError(
    await api("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"password":"${PRIVATE}",`,
    }),
    400,
    "VALIDATION_ERROR",
  );
});

test("shared query and UUID validation work through Nest parameter binding", async () => {
  const page = await api(
    "/shared-test/list?limit=25&cursor=opaque%2B%2F%3D%3D",
  );
  assert.equal(page.status, 200);
  assert.deepEqual(page.body, {
    items: [{ cursor: "opaque+/==", limit: 25 }],
    nextCursor: null,
  });
  expectError(
    await api("/shared-test/list?limit=101"),
    400,
    "VALIDATION_ERROR",
  );
  expectError(await api("/shared-test/list?page=2"), 400, "VALIDATION_ERROR");
  expectError(
    await api(`/shared-test/items/${PRIVATE}`),
    400,
    "VALIDATION_ERROR",
  );
  const id = randomUUID();
  assert.deepEqual((await api(`/shared-test/items/${id}`)).body, { id });
  assert.ok(
    logs.some((entry) => entry.route === "/api/v1/shared-test/items/:id"),
  );
});

test("HTTP and unexpected exceptions retain safe error codes and private content stays hidden", async () => {
  expectError(await api("/shared-test/forbidden"), 403, "FORBIDDEN");
  expectError(
    await api("/shared-test/unavailable"),
    503,
    "SERVICE_UNAVAILABLE",
  );
  expectError(await api("/shared-test/unexpected"), 500, "INTERNAL_ERROR");
});

test("another feature module reuses session auth, rejects revoked tokens and fails closed without its guard", async () => {
  expectError(await api("/shared-test/protected"), 401, "UNAUTHENTICATED");
  expectError(await api("/shared-test/missing-guard"), 401, "UNAUTHENTICATED");
  const credentials = { email: "feature@example.test", password: PRIVATE };
  const registered = await api("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, fullName: "Feature user" }),
  });
  assert.equal(registered.status, 201);
  const login = await api("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);
  const headers = { Authorization: `Bearer ${login.body.accessToken}` };
  const protectedResult = await api("/shared-test/protected", { headers });
  assert.equal(protectedResult.status, 200);
  assert.deepEqual(protectedResult.body, { user: registered.body.user });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await api("/auth/logout", { method: "POST", headers: { Cookie: cookie } }))
      .status,
    204,
  );
  expectError(
    await api("/shared-test/protected", { headers }),
    401,
    "UNAUTHENTICATED",
  );
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(login.body.accessToken));
  assert.ok(!serialized.includes(cookie));
});

test("HTTP logs contain only bounded metadata, including requests with private bodies and URLs", () => {
  assert.ok(logs.length > 10);
  for (const entry of logs) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "durationMs",
      "event",
      "method",
      "requestId",
      "route",
      "statusCode",
    ]);
    assert.equal(entry.event, "http_request");
    assert.ok(Number.isFinite(entry.durationMs));
  }
  assert.ok(!JSON.stringify(logs).includes(PRIVATE));
});
