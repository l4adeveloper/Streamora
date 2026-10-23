const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");

let fixture, browser;
before(
  async () => {
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === "win32" ? "msedge" : undefined,
    });
    fixture = await createFrontendFixture({ docsEnabled: true });
  },
  { timeout: 240000 },
);
after(async () => {
  try {
    if (browser) await browser.close();
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test("Swagger through the frontend executes all six operations with real Origin, HttpOnly rotation and logout", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const foreign = [];
    await page.route("**/*", (route) => {
      const origin = new URL(route.request().url()).origin;
      if (origin !== fixture.webOrigin) {
        foreign.push(origin);
        return route.abort();
      }
      return route.continue();
    });
    const api = `${fixture.webOrigin}/api/v1`;
    await page.goto(`${api}/docs`, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => window.ui && document.querySelectorAll(".opblock").length === 6,
    );
    const email = `swagger-proxy-${randomUUID()}@example.test`;
    const password = "Swagger-proxy-test-password-123!";

    async function execute(method, path, body) {
      const id = path.startsWith("/auth/")
        ? `operations-Auth-auth_${path.split("/").pop()}`
        : `operations-Users-users_${method === "get" ? "me" : "update"}`;
      const block = page.locator(`[id="${id}"]`);
      if (!(await block.locator(".opblock-body").count()))
        await block.locator(".opblock-summary").click();
      await block
        .getByRole("button", { name: "Try it out", exact: true })
        .click();
      const origin = block.locator('input[placeholder="Origin"]');
      if (await origin.count()) await origin.fill(fixture.webOrigin);
      if (body !== undefined)
        await block
          .locator("textarea.body-param__text")
          .fill(JSON.stringify(body));
      const result = page.waitForResponse(
        (r) =>
          r.url() === `${api}${path}` &&
          r.request().method() === method.toUpperCase(),
      );
      await block.getByRole("button", { name: "Execute", exact: true }).click();
      const response = await result;
      assert.equal(response.headers()["cache-control"], "no-store");
      if (method === "post")
        assert.equal(response.request().headers().origin, fixture.webOrigin);
      return response;
    }

    assert.equal(
      (
        await execute("post", "/auth/register", {
          email,
          password,
          fullName: "Swagger qua frontend",
        })
      ).status(),
      201,
    );
    const login = await execute("post", "/auth/login", { email, password });
    assert.equal(login.status(), 200);
    const grant = await login.json();
    const cookieBefore = (await context.cookies(`${api}/auth/refresh`)).find(
      (c) => c.path === "/api/v1/auth",
    );
    assert.ok(cookieBefore?.httpOnly);

    await page
      .getByRole("button", { name: "Authorize", exact: true })
      .first()
      .click();
    const bearer = page
      .locator(".auth-container")
      .filter({ hasText: "accessToken" });
    await bearer.getByRole("textbox").fill(grant.accessToken);
    await bearer
      .getByRole("button", { name: "Apply credentials", exact: true })
      .click();
    await bearer.getByRole("button", { name: "Close", exact: true }).click();
    const me = await execute("get", "/users/me");
    assert.equal(me.status(), 200);
    assert.equal((await me.json()).user.email, email);
    const patched = await execute("patch", "/users/me", {
      fullName: "Tên cập nhật từ Swagger",
    });
    assert.equal(patched.status(), 200);
    assert.equal(
      (await patched.json()).user.fullName,
      "Tên cập nhật từ Swagger",
    );

    const refreshed = await execute("post", "/auth/refresh");
    assert.equal(refreshed.status(), 200);
    const fresh = await refreshed.json();
    const cookieAfter = (await context.cookies(`${api}/auth/refresh`)).find(
      (c) => c.path === "/api/v1/auth",
    );
    assert.ok(cookieAfter?.httpOnly);
    assert.notEqual(cookieAfter.value, cookieBefore.value);
    assert.equal((await execute("post", "/auth/logout")).status(), 204);
    assert.equal(
      (await context.cookies(`${api}/auth/refresh`)).filter(
        (c) => c.path === "/api/v1/auth",
      ).length,
      0,
    );
    assert.equal(
      (
        await context.request.get(`${api}/users/me`, {
          headers: { Authorization: `Bearer ${fresh.accessToken}` },
        })
      ).status(),
      401,
    );

    for (const base of [api, fixture.apiUrl]) {
      const rejected = await context.request.post(`${base}/auth/login`, {
        headers: { Origin: new URL(fixture.apiUrl).origin },
        data: { email, password },
      });
      assert.equal(rejected.status(), 403);
      assert.equal((await rejected.json()).error.code, "ORIGIN_NOT_ALLOWED");
    }
    const stored = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    );
    for (const value of [
      password,
      grant.accessToken,
      fresh.accessToken,
      cookieAfter.value,
    ])
      assert.ok(!stored.includes(value));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.ui));
    assert.equal(
      await page.evaluate(() => window.ui.authSelectors.authorized().size),
      0,
    );
    assert.deepEqual(foreign, []);
  } finally {
    await context.close();
  }
});
