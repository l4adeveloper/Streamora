const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright");
const jwt = require("jsonwebtoken");
const { PrismaService } = require("../../dist/database/prisma.service");
const { createTestDatabase } = require("../integration/database-fixture.cjs");
const {
  createTestTls,
  createBrowserProfile,
  createUntrustedOrigin,
} = require("./browser-fixture.cjs");

let browser, fixture, prisma, tls, local, staging, untrusted;
const PASSWORD = "Browser-only-password-123!";

before(
  async () => {
    try {
      browser = await chromium.launch({
        headless: true,
        channel:
          process.env.STREAMORA_TEST_BROWSER_CHANNEL ??
          (process.platform === "win32" ? "msedge" : undefined),
        args: [
          "--host-resolver-rules=MAP app.streamora.test 127.0.0.1,MAP api.streamora.test 127.0.0.1",
          "--no-proxy-server",
        ],
      });
    } catch {
      throw new Error(
        "Không mở được browser test. Windows mặc định dùng Edge; hoặc npx playwright install chromium rồi đặt STREAMORA_TEST_BROWSER_CHANNEL=chromium.",
      );
    }
    fixture = await createTestDatabase();
    prisma = new PrismaService(fixture.url);
    await prisma.onModuleInit();
    tls = await createTestTls();
    local = await createBrowserProfile(fixture.url);
    staging = await createBrowserProfile(fixture.url, tls.options);
    untrusted = await createUntrustedOrigin();
  },
  { timeout: 120000 },
);

after(async () => {
  // Close clients first so temporary databases and key material can be removed.
  try {
    if (browser) await browser.close();
  } finally {
    try {
      if (untrusted) await untrusted.cleanup();
      if (staging) await staging.cleanup();
      if (local) await local.cleanup();
      if (prisma) await prisma.onModuleDestroy();
    } finally {
      try {
        if (fixture) await fixture.cleanup();
      } finally {
        if (tls) await tls.cleanup();
      }
    }
  }
});

async function withPage(profile, run) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(profile.webOrigin);
    await run(page, context);
  } finally {
    await context.close();
  }
}
async function api(page, profile, path, options = {}) {
  return page.evaluate(
    async ({ url, options }) => {
      const headers = {};
      if (options.body !== undefined)
        headers["Content-Type"] = "application/json";
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      const response = await fetch(url, {
        method: options.method ?? "POST",
        credentials: options.credentials ?? "include",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
        requestId: response.headers.get("x-request-id"),
        setCookieVisible: response.headers.get("set-cookie") !== null,
      };
    },
    { url: `${profile.apiUrl}${path}`, options },
  );
}
async function register(page, profile) {
  const credentials = {
    email: `browser-${randomUUID()}@example.test`,
    password: PASSWORD,
  };
  assert.equal(
    (
      await api(page, profile, "/auth/register", {
        body: { ...credentials, fullName: "Người kiểm thử" },
      })
    ).status,
    201,
  );
  return credentials;
}
async function login(page, profile, credentials) {
  const result = await api(page, profile, "/auth/login", { body: credentials });
  assert.equal(result.status, 200);
  assert.equal(
    result.setCookieVisible,
    false,
    "browser JS must not read Set-Cookie",
  );
  assert.match(result.requestId, /^[a-f0-9-]{36}$/);
  assert.ok(!("refreshToken" in result.body));
  return result;
}
async function refreshCookie(context, profile) {
  const cookies = await context.cookies(`${profile.apiUrl}/auth/refresh`);
  return cookies.find((cookie) => cookie.name === "refreshToken");
}

test("local browser receives an HttpOnly host-only cookie, obeys Path, rotates and restores the session after reload", async () => {
  await withPage(local, async (page, context) => {
    const initial = await login(page, local, await register(page, local));
    const cookie = await refreshCookie(context, local);
    assert.ok(cookie, "login must store refresh cookie");
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, false);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.domain, "127.0.0.1");
    assert.equal(cookie.path, "/api/v1/auth");
    assert.equal((await context.cookies(`${local.apiUrl}/users/me`)).length, 0);
    assert.ok(
      cookie.expires > Date.now() / 1000 &&
        cookie.expires <= Date.now() / 1000 + 604801,
    );
    // Navigate to the API host AND cookie path: an empty document.cookie now proves HttpOnly.
    await page.goto(`${local.apiUrl}/auth/browser-probe`);
    assert.equal(
      await page.evaluate(() => document.cookie.includes("refreshToken=")),
      false,
    );
    await page.goto(local.webOrigin);
    await page.reload();
    const refreshed = await api(page, local, "/auth/refresh");
    assert.equal(refreshed.status, 200);
    const rotated = await refreshCookie(context, local);
    assert.ok(
      rotated && rotated.value !== cookie.value,
      "refresh must rotate the cookie",
    );
    assert.ok(
      rotated.expires <= cookie.expires + 1,
      "refresh must retain absolute expiry",
    );
    assert.equal(
      (
        await api(page, local, "/users/me", {
          method: "GET",
          token: refreshed.body.accessToken,
        })
      ).status,
      200,
    );
    const sessionId = jwt.decode(initial.body.accessToken).sid;
    const saved = await prisma.authRefreshToken.findMany({
      where: { sessionId },
    });
    assert.equal(saved.length, 2);
    assert.ok(
      saved.some(
        (row) =>
          row.tokenHash ===
          createHash("sha256").update(rotated.value).digest("hex"),
      ),
    );
    assert.ok(
      saved.every(
        (row) =>
          row.tokenHash !== rotated.value && row.tokenHash !== cookie.value,
      ),
    );
  });
});

test("credentials=omit cannot set/use a refresh cookie; logout deletes it and rejects the old bearer", async () => {
  await withPage(local, async (page, context) => {
    const credentials = await register(page, local);
    assert.equal(
      (
        await api(page, local, "/auth/login", {
          body: credentials,
          credentials: "omit",
        })
      ).status,
      200,
    );
    assert.equal(await refreshCookie(context, local), undefined);
    const initial = await login(page, local, credentials);
    assert.equal(
      (await api(page, local, "/auth/refresh", { credentials: "omit" })).status,
      401,
    );
    assert.ok(
      await refreshCookie(context, local),
      "omitted credentials must not clear the stored cookie either",
    );
    assert.equal((await api(page, local, "/auth/logout")).status, 204);
    assert.equal(await refreshCookie(context, local), undefined);
    assert.equal(
      (
        await api(page, local, "/users/me", {
          method: "GET",
          token: initial.body.accessToken,
        })
      ).status,
      401,
    );
    assert.equal((await api(page, local, "/auth/refresh")).status, 401);
  });
});

test("untrusted same-site origins cannot mutate sessions through simple requests or JSON preflight", async () => {
  await withPage(local, async (page, context) => {
    await login(page, local, await register(page, local));
    const before = await refreshCookie(context, local);
    await page.goto(untrusted.url);
    for (const endpoint of ["register", "login", "refresh", "logout"]) {
      const url = `${local.apiUrl}/auth/${endpoint}`;
      const previousRequests = local.logs.length;
      const blocked = await page.evaluate(async (url) => {
        try {
          await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "",
          });
          return false;
        } catch {
          return true;
        }
      }, url);
      // Chromium reports a network failure for a response blocked by CORS; inspect
      // the server's metadata sink rather than waiting for a browser response event.
      const rejected = local.logs
        .slice(previousRequests)
        .find(
          (entry) =>
            entry.method === "POST" &&
            entry.route === `/api/v1/auth/${endpoint}`,
        );
      assert.equal(rejected?.statusCode, 403);
      assert.equal(
        blocked,
        true,
        "CORS must prevent the untrusted page from reading responses",
      );
    }
    const previousPosts = local.logs.filter(
      (entry) => entry.method === "POST",
    ).length;
    const preflightBlocked = await page.evaluate(async (url) => {
      try {
        await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        return false;
      } catch {
        return true;
      }
    }, `${local.apiUrl}/auth/logout`);
    assert.equal(preflightBlocked, true);
    assert.equal(
      local.logs.filter((entry) => entry.method === "POST").length,
      previousPosts,
    );
    const after = await refreshCookie(context, local);
    assert.ok(
      after && before.value === after.value,
      "untrusted requests must not replace/delete the cookie",
    );
    await page.goto(local.webOrigin);
    assert.equal(
      (await api(page, local, "/auth/refresh")).status,
      200,
      "untrusted logout must not revoke the session",
    );
  });
});

test("concurrent browser refreshes recover without creating two valid branches", async () => {
  await withPage(local, async (page) => {
    await login(page, local, await register(page, local));
    const results = await Promise.all([
      api(page, local, "/auth/refresh"),
      api(page, local, "/auth/refresh"),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      [200, 200],
    );
    const winner = results.find((result) => result.status === 200);
    assert.equal(
      (
        await api(page, local, "/users/me", {
          method: "GET",
          token: winner.body.accessToken,
        })
      ).status,
      200,
    );
    assert.equal((await api(page, local, "/auth/refresh")).status, 200);
  });
});

test("HTTPS staging profile supports different same-site hosts with Secure cookies and deletes them on logout", async () => {
  await withPage(staging, async (page, context) => {
    await login(page, staging, await register(page, staging));
    const cookie = await refreshCookie(context, staging);
    assert.ok(cookie);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.domain, "api.streamora.test");
    assert.equal(
      (await context.cookies(`${staging.webOrigin}/api/v1/auth/refresh`))
        .length,
      0,
    );
    assert.equal(
      (
        await context.cookies(
          staging.apiUrl.replace("https:", "http:") + "/auth/refresh",
        )
      ).length,
      0,
    );
    await page.goto(`${staging.apiUrl}/auth/browser-probe`);
    assert.equal(
      await page.evaluate(() => document.cookie.includes("refreshToken=")),
      false,
    );
    await page.goto(staging.webOrigin);
    assert.equal((await api(page, staging, "/auth/refresh")).status, 200);
    assert.equal((await api(page, staging, "/auth/logout")).status, 204);
    assert.equal(await refreshCookie(context, staging), undefined);
  });
});

test("expired and disabled sessions clear refresh cookies in the browser with matching attributes", async () => {
  await withPage(local, async (page, context) => {
    const initial = await login(page, local, await register(page, local));
    await prisma.authSession.update({
      where: { id: jwt.decode(initial.body.accessToken).sid },
      data: {
        createdAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 3600000),
      },
    });
    const expired = await api(page, local, "/auth/refresh");
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, "REFRESH_EXPIRED");
    assert.equal(await refreshCookie(context, local), undefined);
  });
  await withPage(staging, async (page, context) => {
    const initial = await login(page, staging, await register(page, staging));
    await prisma.user.update({
      where: { id: initial.body.user.id },
      data: { disabledAt: new Date() },
    });
    const disabled = await api(page, staging, "/auth/refresh");
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.error.code, "USER_DISABLED");
    assert.equal(await refreshCookie(context, staging), undefined);
  });
});
