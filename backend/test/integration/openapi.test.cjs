const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../../dist/modules/app.module");
const { configureApplication } = require("../../dist/app");
const { createTestDatabase } = require("./database-fixture.cjs");
const { runAuthDemo } = require("../../scripts/demo-auth.cjs");
let fixture, app, production, base, offBase, doc;
const origin = "http://127.0.0.1:3000";
before(
  async () => {
    fixture = await createTestDatabase();
    const config = {
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
    app = await NestFactory.create(AppModule.forRoot(config), {
      logger: false,
    });
    configureApplication(app, config, { requestLog: () => {} });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const offConfig = {
      ...config,
      nodeEnv: "production",
      docsEnabled: false,
      webOrigin: "https://app.example.test",
      auth: { ...config.auth, cookie: { ...config.auth.cookie, secure: true } },
    };
    production = await NestFactory.create(AppModule.forRoot(offConfig), {
      logger: false,
    });
    configureApplication(production, offConfig, { requestLog: () => {} });
    await production.listen(0, "127.0.0.1");
    offBase = await production.getUrl();
    doc = await (await fetch(`${base}/api/v1/docs-json`)).json();
  },
  { timeout: 120000 },
);
after(async () => {
  try {
    if (app) await app.close();
    if (production) await production.close();
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test("enabled Swagger serves local UI/assets and a versioned document without exposing demo routes or YAML", async () => {
  const ui = await fetch(`${base}/api/v1/docs`);
  assert.equal(ui.status, 200);
  assert.match(ui.headers.get("cache-control"), /no-store/);
  assert.ok((await ui.text()).includes("swagger-ui"));
  const json = await fetch(`${base}/api/v1/docs-json`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await json.json(), require("../../docs/openapi.json"));
  assert.equal(
    (await fetch(`${base}/api/v1/docs/swagger-ui-bundle.js`)).status,
    200,
  );
  assert.equal((await fetch(`${base}/api/v1/docs-yaml`)).status, 404);
  assert.equal((await fetch(`${base}/docs`)).status, 404);
});

test("disabled production docs have no UI, JSON or asset endpoints while the API keeps working", async () => {
  for (const path of [
    "docs",
    "docs/",
    "docs-json",
    "docs-yaml",
    "docs/swagger-ui-init.js",
    "docs/swagger-ui-bundle.js",
  ])
    assert.equal((await fetch(`${offBase}/api/v1/${path}`)).status, 404);
  assert.equal((await fetch(`${offBase}/api/v1/health`)).status, 200);
});

function checkResponse(path, method, status, value) {
  const response = doc.paths[`/api/v1${path}`][method].responses[status];
  assert.ok(response);
  if (status === 204) {
    assert.equal(response.content, undefined);
    assert.equal(value, "");
    return;
  }
  function check(schema, data) {
    if (schema.$ref)
      schema = doc.components.schemas[schema.$ref.split("/").pop()];
    if (schema.allOf) {
      schema.allOf.forEach((child) => check(child, data));
      return;
    }
    if (schema.type === "object") {
      for (const key of schema.required ?? [])
        assert.ok(Object.hasOwn(data, key));
      for (const [key, child] of Object.entries(schema.properties))
        if (Object.hasOwn(data, key)) check(child, data[key]);
      assert.ok(
        Object.keys(data).every((key) => Object.hasOwn(schema.properties, key)),
      );
    } else if (schema.type === "integer") assert.ok(Number.isInteger(data));
    else if (schema.type) assert.equal(typeof data, schema.type);
    if (schema.enum) assert.ok(schema.enum.includes(data));
  }
  check(response.content["application/json"].schema, value);
}
test("all six live auth/profile responses follow the documented schemas and retain the strict Origin guard", async () => {
  const credentials = {
    email: `openapi-${randomUUID()}@example.test`,
    password: "OpenAPI-only-password-123!",
  };
  let cookie, token;
  async function call(path, method, body, expected) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method: method.toUpperCase(),
      headers: {
        Origin: origin,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value =
      response.status === 204 ? await response.text() : await response.json();
    assert.equal(response.status, expected);
    checkResponse(path, method, response.status, value);
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    token = value?.accessToken ?? token;
  }
  await call(
    "/auth/register",
    "post",
    { ...credentials, fullName: "Tài khoản tài liệu" },
    201,
  );
  await call("/auth/login", "post", credentials, 200);
  await call("/users/me", "get", undefined, 200);
  await call("/users/me", "patch", { fullName: "Đã cập nhật" }, 200);
  await call("/auth/refresh", "post", undefined, 200);
  await call("/auth/logout", "post", undefined, 204);
  await call("/users/me", "get", undefined, 401);
  const forbidden = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "ORIGIN_NOT_ALLOWED");
});

test("the handoff demo verifies real auth/profile/rotation/logout without returning credentials", async () => {
  const result = await runAuthDemo({ apiUrl: `${base}/api/v1`, origin });
  assert.equal(result.steps.length, 12);
  assert.ok(result.steps.includes("POST /auth/logout: 204"));
  assert.ok(result.steps.includes("POST /auth/refresh: 401"));
  assert.ok(!JSON.stringify(result).includes("accessToken"));
  assert.ok(!JSON.stringify(result).includes("password"));
});
