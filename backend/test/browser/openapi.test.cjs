const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { mkdir } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { chromium } = require("playwright");
const { createTestDatabase } = require("../integration/database-fixture.cjs");
const { createBrowserProfile } = require("./browser-fixture.cjs");
let fixture, profile, browser;
before(
  async () => {
    fixture = await createTestDatabase();
    profile = await createBrowserProfile(fixture.url, undefined, {
      docsEnabled: true,
    });
    browser = await chromium.launch({
      headless: true,
      channel:
        process.env.STREAMORA_TEST_BROWSER_CHANNEL ??
        (process.platform === "win32" ? "msedge" : undefined),
    });
  },
  { timeout: 120000 },
);
after(async () => {
  try {
    if (browser) await browser.close();
    if (profile) await profile.cleanup();
  } finally {
    if (fixture) await fixture.cleanup();
  }
});
test("Swagger renders six operations, tries a real Bearer GET and clears authorization on reload without external requests", async () => {
  const credentials = {
    email: `swagger-${randomUUID()}@example.test`,
    password: "Swagger-browser-test-password-123!",
  };
  const headers = {
    Origin: profile.webOrigin,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(`${profile.apiUrl}/auth/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...credentials, fullName: "Swagger test" }),
      })
    ).status,
    201,
  );
  const grantResponse = await fetch(`${profile.apiUrl}/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify(credentials),
  });
  assert.equal(grantResponse.status, 200);
  const grant = await grantResponse.json();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const foreign = [];
    const apiOrigin = new URL(profile.apiUrl).origin;
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== apiOrigin) {
        foreign.push(url.origin);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(
      `${profile.apiUrl}/docs?url=https://untrusted.example/spec.json`,
      { waitUntil: "networkidle" },
    );
    await page.waitForFunction(
      () => window.ui && document.querySelectorAll(".opblock").length === 6,
    );
    assert.equal(await page.locator(".opblock").count(), 6);
    const preview = resolve(__dirname, "../../../.preview");
    await mkdir(preview, { recursive: true });
    await page.screenshot({
      path: join(preview, "swagger-t01.png"),
      fullPage: true,
    });
    const post = page.locator(".opblock-post").first();
    await post.locator(".opblock-summary").click();
    await post.getByRole("button", { name: "Try it out", exact: true }).waitFor();
    assert.equal(
      await post
        .getByRole("button", { name: "Try it out", exact: true })
        .count(),
      1,
    );
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
    const get = page.locator(".opblock-get");
    await get.locator(".opblock-summary").click();
    await get.getByRole("button", { name: "Try it out", exact: true }).click();
    const response = page.waitForResponse(
      (result) =>
        result.url() === `${profile.apiUrl}/users/me` &&
        result.request().method() === "GET",
    );
    await get.getByRole("button", { name: "Execute", exact: true }).click();
    const actual = await response;
    assert.equal(actual.status(), 200);
    assert.equal((await actual.json()).user.email, credentials.email);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.ui));
    assert.equal(
      await page.evaluate(() => window.ui.authSelectors.authorized().size),
      0,
    );
    const stored = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    );
    assert.ok(!stored.includes(grant.accessToken));
    assert.ok(!stored.includes(credentials.password));
    assert.deepEqual(foreign, []);
  } finally {
    await context.close();
  }
});
