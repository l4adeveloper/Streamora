const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { parseEnv } = require("node:util");
const { tmpdir } = require("node:os");
const { join, dirname, resolve, basename } = require("node:path");
const {
  readEnvironment,
  loadEnvironmentFile,
} = require("../dist/config/environment");

const environment = (overrides = {}) => ({
  NODE_ENV: "test",
  ACCESS_TOKEN_SECRET: "test-only-signing-key-with-at-least-32-bytes",
  DATABASE_URL: "postgresql://streamora:test@127.0.0.1:5432/streamora",
  ...overrides,
});

test("local defaults resolve prefix cookie scope and token lifetimes", () => {
  const config = readEnvironment(environment());
  assert.equal(config.port, 4000);
  assert.equal(config.auth.accessTokenTtlSeconds, 900);
  assert.equal(config.auth.refreshTokenTtlSeconds, 604800);
  assert.deepEqual(config.auth.cookie, {
    name: "refreshToken",
    path: "/api/v1/auth",
    httpOnly: true,
    secure: false,
    sameSite: "lax",
  });
});

test("invalid configuration fails without disclosing its supplied value", () => {
  for (const [key, value] of [
    ["NODE_ENV", "invalid-mode"],
    ["API_PORT", "4000-invalid"],
    ["API_PORT", "65536"],
    ["API_PORT", "0"],
    ["API_DOCS_ENABLED", "not-a-boolean"],
    ["ACCESS_TOKEN_SECRET", "short-secret"],
    [
      "ACCESS_TOKEN_SECRET",
      "replace-with-secret-that-is-long-enough-but-is-a-placeholder",
    ],
    ["ACCESS_TOKEN_TTL_SECONDS", "-1234"],
    ["REFRESH_TOKEN_TTL_SECONDS", "999999999999999999999"],
    ["REFRESH_TOKEN_TTL_SECONDS", "899"],
    ["AUTH_COOKIE_SECURE", "not-a-boolean"],
    ["AUTH_COOKIE_SAME_SITE", "invalid-samesite"],
    ["WEB_ORIGIN", "https://example.com/private"],
    ["WEB_ORIGIN", "*"],
    ["DATABASE_URL", "mysql://secret-user:private-password@db/app"],
  ]) {
    assert.throws(
      () => readEnvironment(environment({ [key]: value })),
      (error) => {
        assert.equal(error.message, `Cấu hình ${key} không hợp lệ.`);
        assert.ok(!error.message.includes(value));
        return true;
      },
    );
  }
  assert.throws(() => readEnvironment({}), /ACCESS_TOKEN_SECRET/);
});

test("API docs default to development only and explicit deployment values take precedence", () => {
  assert.equal(
    readEnvironment(environment({ NODE_ENV: "development" })).docsEnabled,
    true,
  );
  assert.equal(readEnvironment(environment()).docsEnabled, false);
  const production = {
    NODE_ENV: "production",
    WEB_ORIGIN: "https://app.example.test",
  };
  assert.equal(readEnvironment(environment(production)).docsEnabled, false);
  assert.equal(
    readEnvironment(environment({ ...production, API_DOCS_ENABLED: "true" }))
      .docsEnabled,
    true,
  );
  assert.equal(
    readEnvironment(
      environment({ NODE_ENV: "development", API_DOCS_ENABLED: "false" }),
    ).docsEnabled,
    false,
  );
});

test("production requires HTTPS and secure cookies; cross-site cookies also require Secure", () => {
  assert.throws(
    () => readEnvironment(environment({ NODE_ENV: "production" })),
    /WEB_ORIGIN/,
  );
  assert.throws(
    () =>
      readEnvironment(
        environment({
          NODE_ENV: "production",
          WEB_ORIGIN: "https://streamora.example",
          AUTH_COOKIE_SECURE: "false",
        }),
      ),
    /AUTH_COOKIE_SECURE/,
  );
  assert.throws(
    () => readEnvironment(environment({ AUTH_COOKIE_SAME_SITE: "none" })),
    /AUTH_COOKIE_SAME_SITE/,
  );
  const config = readEnvironment(
    environment({
      NODE_ENV: "production",
      WEB_ORIGIN: "https://streamora.example",
      AUTH_COOKIE_SAME_SITE: "none",
    }),
  );
  assert.equal(config.auth.cookie.secure, true);
  assert.equal(config.auth.cookie.sameSite, "none");
});

test("loading a local env file preserves deployment values and tolerates an absent file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "streamora-env-load-"));
  const key = "STREAMORA_ENV_PRECEDENCE_TEST";
  const previous = process.env[key];
  try {
    process.env[key] = "deployment";
    const path = join(directory, ".env");
    await writeFile(path, `${key}=local\n`);
    loadEnvironmentFile(path);
    assert.equal(process.env[key], "deployment");
    assert.doesNotThrow(() =>
      loadEnvironmentFile(join(directory, "missing.env")),
    );
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("streamora-env-load-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("staging templates enforce HTTPS/Secure and keep frontend configuration public", async () => {
  const root = resolve(__dirname, "../..");
  const backend = parseEnv(
    await readFile(join(root, "backend/.env.staging.example"), "utf8"),
  );
  assert.throws(() => readEnvironment(backend), /ACCESS_TOKEN_SECRET/);
  const config = readEnvironment({
    ...backend,
    ACCESS_TOKEN_SECRET: environment().ACCESS_TOKEN_SECRET,
  });
  assert.equal(config.nodeEnv, "production");
  assert.equal(config.auth.cookie.secure, true);
  assert.equal(config.auth.cookie.sameSite, "lax");
  assert.equal(new URL(config.webOrigin).protocol, "https:");
  const web = parseEnv(
    await readFile(join(root, "frontend/.env.staging.example"), "utf8"),
  );
  assert.ok(Object.keys(web).every((key) => key.startsWith("NEXT_PUBLIC_")));
  assert.equal(new URL(web.NEXT_PUBLIC_API_URL).protocol, "https:");
  assert.equal(new URL(web.NEXT_PUBLIC_API_URL).pathname, "/api/v1");
});
