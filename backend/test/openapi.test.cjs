const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const { exportOpenApi } = require("../scripts/export-openapi.cjs");
const { PrismaService } = require("../dist/database/prisma.service");
const { AUTH_CONSTRAINTS } = require("@streamora/contracts");

let doc;
before(async () => {
  doc = await exportOpenApi({ check: true });
});

test("OpenAPI exports deterministically without initializing the database or reading deployment credentials", async () => {
  const original = PrismaService.prototype.onModuleInit;
  const savedUrl = process.env.DATABASE_URL,
    savedSecret = process.env.ACCESS_TOKEN_SECRET;
  const sentinel = "deployment-value-must-not-enter-openapi";
  let connections = 0;
  try {
    process.env.DATABASE_URL = sentinel;
    process.env.ACCESS_TOKEN_SECRET = sentinel;
    PrismaService.prototype.onModuleInit = async () => {
      connections++;
      throw new Error("Unexpected database initialization");
    };
    const second = await exportOpenApi({ check: true });
    assert.deepEqual(second, doc);
    assert.equal(connections, 0);
    assert.ok(!JSON.stringify(second).includes(sentinel));
  } finally {
    PrismaService.prototype.onModuleInit = original;
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.ACCESS_TOKEN_SECRET;
    else process.env.ACCESS_TOKEN_SECRET = savedSecret;
  }
});

test("OpenAPI publishes exactly six versioned T01 operations with valid schema references and public response fields", () => {
  assert.deepEqual(Object.keys(doc.paths).sort(), [
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
    "/api/v1/auth/refresh",
    "/api/v1/auth/register",
    "/api/v1/users/me",
  ]);
  assert.equal(Object.values(doc.paths).flatMap(Object.values).length, 6);
  assert.deepEqual(
    Object.keys(doc.components.schemas.PublicUserDto.properties).sort(),
    ["email", "fullName", "globalRole", "id"],
  );
  assert.deepEqual(
    Object.keys(doc.components.schemas.LoginResponseDto.properties).sort(),
    ["accessToken", "expiresIn", "user"],
  );
  assert.deepEqual(
    Object.keys(
      doc.components.schemas.AccessTokenResponseDto.properties,
    ).sort(),
    ["accessToken", "expiresIn"],
  );
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      assert.match(value.$ref, /^#\/components\/schemas\//);
      assert.ok(doc.components.schemas[value.$ref.split("/").pop()]);
    }
    Object.values(value).forEach(visit);
  }
  visit(doc);
});

test("OpenAPI retains auth Origin/cookie/bearer policies, empty bodies, DTO constraints and error contracts", () => {
  const auth = (name) => doc.paths[`/api/v1/auth/${name}`].post;
  for (const name of ["register", "login", "refresh", "logout"])
    assert.ok(
      auth(name).parameters.some(
        (p) => p.in === "header" && p.name === "Origin" && p.required,
      ),
    );
  assert.deepEqual(auth("register").security, []);
  assert.deepEqual(auth("login").security, []);
  assert.deepEqual(auth("refresh").security, [{ refreshCookie: [] }]);
  assert.deepEqual(doc.paths["/api/v1/users/me"].get.security, [
    { accessToken: [] },
  ]);
  assert.deepEqual(doc.paths["/api/v1/users/me"].patch.security, [
    { accessToken: [] },
  ]);
  assert.equal(auth("refresh").requestBody, undefined);
  assert.equal(auth("logout").requestBody, undefined);
  assert.equal(auth("logout").responses[204].content, undefined);
  const schemas = doc.components.schemas;
  assert.equal(
    schemas.RegisterDto.properties.password.minLength,
    AUTH_CONSTRAINTS.passwordMinLength,
  );
  assert.equal(schemas.RegisterDto.properties.password.writeOnly, true);
  for (const name of ["RegisterDto", "LoginDto", "UpdateProfileDto"])
    assert.equal(schemas[name].additionalProperties, false);
  assert.deepEqual(Object.keys(schemas.UpdateProfileDto.properties), [
    "fullName",
  ]);
  for (const item of Object.values(doc.paths))
    for (const operation of Object.values(item))
      for (const [status, response] of Object.entries(operation.responses))
        if (Number(status) >= 400)
          assert.equal(
            response.content["application/json"].schema.$ref,
            "#/components/schemas/ApiErrorResponseDto",
          );
});
