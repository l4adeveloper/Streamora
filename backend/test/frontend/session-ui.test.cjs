const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");

let browser, fixture;
const PASSWORD = "Session-ui-password-123!";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
before(
  async () => {
    browser = await chromium.launch({
      headless: true,
      channel:
        process.env.STREAMORA_TEST_BROWSER_CHANNEL ??
        (process.platform === "win32" ? "msedge" : undefined),
    });
    fixture = await createFrontendFixture({ sessionProbe: true });
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
async function withContext(run, init) {
  const context = await browser.newContext();
  context.setDefaultTimeout(12000);
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.abort(),
  );
  if (init) await context.addInitScript(init);
  try {
    await run(context, await context.newPage());
  } finally {
    await context.close();
  }
}
async function seed() {
  const email = `session-${randomUUID()}@example.test`;
  const response = await fetch(`${fixture.apiUrl}/auth/register`, {
    method: "POST",
    headers: { Origin: fixture.webOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      fullName: "Người dùng phiên",
    }),
  });
  assert.equal(response.status, 201);
  return { email, user: (await response.json()).user };
}
async function login(page, account) {
  await page.goto(`${fixture.webOrigin}/login`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => {
    const field = document.querySelector('input[name="email"]');
    return field && !field.closest("fieldset").disabled;
  });
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD);
  const response = page.waitForResponse(`${fixture.apiUrl}/auth/login`);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  const body = await (await response).json();
  await page.waitForURL("**/workspace");
  await page
    .locator(".workspace-identity .session-identity")
    .getByText("Người dùng phiên", { exact: true })
    .waitFor();
  // Login opens the workspace. Profile/session cases below operate on /account.
  await page.goto(`${fixture.webOrigin}/account`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("heading", { name: "Người dùng phiên", exact: true })
    .waitFor();
  return jwt.decode(body.accessToken).sid;
}
async function probe(page, account) {
  await page.goto(`${fixture.webOrigin}/session-probe`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    (email) =>
      document.querySelector('[data-testid="user"]')?.textContent === email,
    account.email,
  );
}
const result = (page, text) =>
  page.waitForFunction(
    (text) =>
      document.querySelector('[data-testid="result"]')?.textContent === text,
    text,
  );
function countRefreshes(page) {
  let count = 0;
  page.on("request", (request) => {
    if (
      request.url() === `${fixture.apiUrl}/auth/refresh` &&
      request.method() === "POST"
    )
      count++;
  });
  return () => count;
}
function headers() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": fixture.webOrigin,
    "Access-Control-Allow-Credentials": "true",
  };
}
async function errorResponse(route, status, code) {
  await route.fulfill({
    status,
    headers: headers(),
    body: JSON.stringify({
      error: { code, message: "Safe test error" },
      requestId: randomUUID(),
    }),
  });
}
async function expireWireRequests(page, method, { lateThird = false } = {}) {
  let original,
    oldRequests = 0;
  await page.route(`${fixture.apiUrl}/users/me`, async (route) => {
    const request = route.request();
    if (request.method() !== method) return route.continue();
    const originalHeaders = request.headers();
    original ??= originalHeaders.authorization;
    if (originalHeaders.authorization !== original) return route.continue();
    oldRequests++;
    if (lateThird && oldRequests === 3) await delay(900);
    await route.continue({
      headers: {
        ...originalHeaders,
        authorization: `Bearer ${fixture.expireAccessToken(original.slice(7))}`,
      },
    });
  });
  return () => oldRequests;
}
const tokens = (id) =>
  fixture.prisma.authRefreshToken.count({ where: { sessionId: id } });

test("an expired bearer refreshes once and replays the original PATCH body", async () => {
  const account = await seed();
  await withContext(async (_context, page) => {
    const sid = await login(page, account);
    const baseline = await tokens(sid);
    const refreshes = countRefreshes(page);
    const bodies = [];
    let first = true;
    await page.route(`${fixture.apiUrl}/users/me`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      bodies.push(route.request().postDataJSON());
      if (!first) return route.continue();
      first = false;
      const original = route.request().headers();
      await route.continue({
        headers: {
          ...original,
          authorization: `Bearer ${fixture.expireAccessToken(original.authorization.slice(7))}`,
        },
      });
    });
    await page
      .getByLabel("Họ và tên", { exact: true })
      .fill("Tên sau khi refresh");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Đã cập nhật họ và tên." })
      .waitFor();
    assert.equal(refreshes(), 1);
    assert.deepEqual(bodies, [
      { fullName: "Tên sau khi refresh" },
      { fullName: "Tên sau khi refresh" },
    ]);
    assert.equal(await tokens(sid), baseline + 1);
    assert.equal(
      (await fixture.prisma.user.findUnique({ where: { id: account.user.id } }))
        .fullName,
      "Tên sau khi refresh",
    );
  });
});

test("parallel 401s and a late old-token 401 share a single refresh", async () => {
  const account = await seed();
  await withContext(async (_context, page) => {
    const sid = await login(page, account);
    await probe(page, account);
    const baseline = await tokens(sid);
    const refreshes = countRefreshes(page);
    await expireWireRequests(page, "GET", { lateThird: true });
    await page.getByRole("button", { name: "Gửi 3 yêu cầu" }).click();
    await result(page, "ok,ok,ok");
    assert.equal(refreshes(), 1);
    assert.equal(await tokens(sid), baseline + 1);
    assert.equal(
      (await fixture.prisma.authSession.findUnique({ where: { id: sid } }))
        .revokedAt,
      null,
    );
  });
});

test("non-auth errors are not replayed and a second 401 cannot cause a refresh loop", async () => {
  const account = await seed();
  await withContext(async (_context, page) => {
    await login(page, account);
    await probe(page, account);
    const refreshes = countRefreshes(page);
    let patches = 0,
      status = 403,
      code = "FORBIDDEN";
    await page.route(`${fixture.apiUrl}/users/me`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      patches++;
      await errorResponse(route, status, code);
    });
    await page.getByLabel("Tên thử nghiệm").fill("Không được gửi lặp");
    await page.getByRole("button", { name: "Gửi cập nhật" }).click();
    await result(page, "FORBIDDEN");
    assert.equal(patches, 1);
    assert.equal(refreshes(), 0);
    status = 500;
    code = "INTERNAL_ERROR";
    await page.getByRole("button", { name: "Gửi cập nhật" }).click();
    await result(page, "INTERNAL_ERROR");
    assert.equal(patches, 2);
    assert.equal(refreshes(), 0);
    status = 401;
    code = "UNAUTHENTICATED";
    await page.getByRole("button", { name: "Gửi cập nhật" }).click();
    await result(page, "UNAUTHENTICATED");
    assert.equal(patches, 4);
    assert.equal(refreshes(), 1);
    assert.equal(await page.getByTestId("user").textContent(), "guest");
  });
});

test("a temporary refresh failure preserves the session and allows an explicit retry", async () => {
  const account = await seed();
  await withContext(async (context, page) => {
    const sid = await login(page, account);
    await probe(page, account);
    const baseline = await tokens(sid);
    await expireWireRequests(page, "PATCH");
    const unavailable = (route) =>
      errorResponse(route, 503, "SERVICE_UNAVAILABLE");
    await page.route(`${fixture.apiUrl}/auth/refresh`, unavailable);
    await page.getByLabel("Tên thử nghiệm").fill("Lưu sau khi kết nối lại");
    await page.getByRole("button", { name: "Gửi cập nhật" }).click();
    await result(page, "SERVICE_UNAVAILABLE");
    assert.equal(await page.getByTestId("user").textContent(), account.email);
    assert.ok(
      (await context.cookies(`${fixture.apiUrl}/auth/refresh`)).some(
        (cookie) => cookie.name === "refreshToken",
      ),
    );
    assert.equal(await tokens(sid), baseline);
    await page.unroute(`${fixture.apiUrl}/auth/refresh`, unavailable);
    await page.getByRole("button", { name: "Gửi cập nhật" }).click();
    await result(page, "saved");
    assert.equal(await tokens(sid), baseline + 1);
    assert.equal(
      (await fixture.prisma.user.findUnique({ where: { id: account.user.id } }))
        .fullName,
      "Lưu sau khi kết nối lại",
    );
  });
});

test("revocation ends the session in every tab and protected pages return to login", async () => {
  const account = await seed();
  await withContext(async (context, page) => {
    const sid = await login(page, account);
    const second = await context.newPage();
    await second.goto(`${fixture.webOrigin}/account`, {
      waitUntil: "domcontentloaded",
    });
    await second
      .getByRole("heading", { name: "Người dùng phiên", exact: true })
      .waitFor();
    await fixture.prisma.authSession.update({
      where: { id: sid },
      data: { revokedAt: new Date(), revocationReason: "LOGOUT" },
    });
    await page.getByLabel("Họ và tên", { exact: true }).fill("Không được lưu");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await Promise.all([
      page.waitForURL("**/login"),
      second.waitForURL("**/login"),
    ]);
    await page
      .getByRole("status")
      .filter({ hasText: "Vui lòng đăng nhập lại." })
      .waitFor();
    assert.equal(
      (await fixture.prisma.user.findUnique({ where: { id: account.user.id } }))
        .fullName,
      "Người dùng phiên",
    );
    assert.equal(
      (await context.cookies(`${fixture.apiUrl}/auth/refresh`)).length,
      0,
    );
  });
});

test("disabling an active account removes protected UI in every tab and never commits its pending profile change", async () => {
  const account = await seed();
  await withContext(async (context, page) => {
    await login(page, account);
    const second = await context.newPage();
    await second.goto(`${fixture.webOrigin}/account`, {
      waitUntil: "domcontentloaded",
    });
    await second
      .getByRole("heading", { name: "Người dùng phiên", exact: true })
      .waitFor();
    await fixture.prisma.user.update({
      where: { id: account.user.id },
      data: { disabledAt: new Date() },
    });
    let writes = 0;
    page.on("request", (request) => {
      if (
        request.url() === `${fixture.apiUrl}/users/me` &&
        request.method() === "PATCH"
      )
        writes++;
    });
    await page
      .getByLabel("Họ và tên", { exact: true })
      .fill("Không lưu khi bị khóa");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await Promise.all([
      page.waitForURL("**/login"),
      second.waitForURL("**/login"),
    ]);
    await page
      .getByRole("status")
      .filter({ hasText: "Tài khoản đã bị khóa" })
      .waitFor();
    assert.equal(writes, 1);
    assert.equal(
      (await fixture.prisma.user.findUnique({ where: { id: account.user.id } }))
        .fullName,
      "Người dùng phiên",
    );
    assert.equal(
      await fixture.prisma.authSession.count({
        where: { userId: account.user.id, revokedAt: null },
      }),
      0,
    );
    assert.equal(
      (await context.cookies(`${fixture.apiUrl}/auth/refresh`)).filter(
        (cookie) => cookie.name === "refreshToken",
      ).length,
      0,
    );
    for (const tab of [page, second]) {
      assert.equal(
        await tab.getByRole("button", { name: "Lưu thay đổi" }).count(),
        0,
      );
      assert.equal(
        await tab
          .getByRole("heading", { name: "Người dùng phiên", exact: true })
          .count(),
        0,
      );
    }
    // Re-enabling the account must not resurrect the revoked session on reload.
    await fixture.prisma.user.update({
      where: { id: account.user.id },
      data: { disabledAt: null },
    });
    await page.goto(`${fixture.webOrigin}/account`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL("**/login");
    assert.equal(
      await page.getByRole("button", { name: "Lưu thay đổi" }).count(),
      0,
    );
  });
});

test("absolute refresh expiry signs every tab out without a refresh loop or a surviving refresh cookie", async () => {
  const account = await seed();
  await withContext(async (context, page) => {
    const sid = await login(page, account);
    await probe(page, account);
    const second = await context.newPage();
    await second.goto(`${fixture.webOrigin}/account`, {
      waitUntil: "domcontentloaded",
    });
    await second
      .getByRole("heading", { name: "Người dùng phiên", exact: true })
      .waitFor();
    const before = await tokens(sid);
    await fixture.prisma.authSession.update({
      where: { id: sid },
      data: {
        createdAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 3600000),
      },
    });
    const refreshes = countRefreshes(page);
    await page
      .getByRole("button", { name: "Làm mới phiên", exact: true })
      .click();
    // The public probe stays open, but its account state must become anonymous.
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="phase"]')?.textContent ===
        "anonymous",
    );
    await second.waitForURL("**/login");
    await second
      .getByRole("status")
      .filter({ hasText: "Vui lòng đăng nhập lại." })
      .waitFor();
    assert.equal(refreshes(), 1);
    assert.equal(await tokens(sid), before);
    assert.equal(await page.getByTestId("user").textContent(), "guest");
    assert.equal(
      await page.getByRole("button", { name: "Gửi cập nhật" }).isDisabled(),
      true,
    );
    assert.equal(
      (await context.cookies(`${fixture.apiUrl}/auth/refresh`)).filter(
        (cookie) => cookie.name === "refreshToken",
      ).length,
      0,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="phase"]')?.textContent ===
        "anonymous",
    );
    assert.equal(refreshes(), 1);
    assert.equal(
      await page.getByRole("button", { name: "Gửi cập nhật" }).isDisabled(),
      true,
    );
  });
});

test("several tabs restoring simultaneously serialize cookie rotation without token reuse", async () => {
  const account = await seed();
  await withContext(async (context, page) => {
    const sid = await login(page, account);
    const pages = await Promise.all(
      Array.from({ length: 3 }, () => context.newPage()),
    );
    await Promise.all(
      pages.map(async (other) => {
        await other.goto(`${fixture.webOrigin}/account`, {
          waitUntil: "domcontentloaded",
        });
        await other
          .getByRole("heading", { name: "Người dùng phiên", exact: true })
          .waitFor();
      }),
    );
    const session = await fixture.prisma.authSession.findUnique({
      where: { id: sid },
    });
    assert.equal(session.revokedAt, null);
    assert.equal(
      await fixture.prisma.authRefreshToken.count({
        where: { sessionId: sid, consumedAt: null },
      }),
      1,
    );
    await pages[1]
      .getByRole("button", { name: "Đăng xuất", exact: true })
      .click();
    await Promise.all(
      [page, ...pages].map((other) => other.waitForURL("**/login")),
    );
  });
});

test("logout queued behind an in-flight refresh cannot resurrect the session", async () => {
  const account = await seed();
  await withContext(async (context, page) => {
    const sid = await login(page, account);
    await probe(page, account);
    const second = await context.newPage();
    await second.goto(`${fixture.webOrigin}/account`, {
      waitUntil: "domcontentloaded",
    });
    await second
      .getByRole("heading", { name: "Người dùng phiên", exact: true })
      .waitFor();
    const entered = deferred(),
      release = deferred();
    await page.route(`${fixture.apiUrl}/auth/refresh`, async (route) => {
      entered.resolve();
      await release.promise;
      await route.continue();
    });
    await page.getByRole("button", { name: "Làm mới phiên" }).click();
    await entered.promise;
    await second
      .getByRole("button", { name: "Đăng xuất", exact: true })
      .click();
    await second.getByRole("button", { name: "Đang đăng xuất…" }).waitFor();
    release.resolve();
    await second.waitForURL("**/login");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="user"]')?.textContent === "guest",
    );
    assert.ok(
      (await fixture.prisma.authSession.findUnique({ where: { id: sid } }))
        .revokedAt,
    );
    assert.equal(
      (await context.cookies(`${fixture.apiUrl}/auth/refresh`)).length,
      0,
    );
  });
});

test("account switching discards old in-flight results and never replays a mutation for the new user", async () => {
  const first = await seed(),
    next = await seed();
  await withContext(async (context, page) => {
    await login(page, first);
    await probe(page, first);
    const second = await context.newPage();
    await second.goto(`${fixture.webOrigin}/account`, {
      waitUntil: "domcontentloaded",
    });
    await second
      .getByRole("heading", { name: "Người dùng phiên", exact: true })
      .waitFor();
    const entered = deferred(),
      release = deferred();
    let patches = 0;
    await page.route(`${fixture.apiUrl}/users/me`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      patches++;
      entered.resolve();
      await release.promise;
      await route.continue();
    });
    await page
      .getByLabel("Tên thử nghiệm")
      .fill("Tên không được ghi sang tài khoản khác");
    await page.getByRole("button", { name: "Gửi cập nhật" }).click();
    await entered.promise;
    await second
      .getByRole("button", { name: "Đăng xuất", exact: true })
      .click();
    await second.waitForURL("**/login");
    await login(second, next);
    await page.waitForFunction(
      (email) =>
        document.querySelector('[data-testid="user"]')?.textContent === email,
      next.email,
    );
    release.resolve();
    await result(page, "SESSION_CHANGED");
    assert.equal(patches, 1);
    for (const account of [first, next])
      assert.equal(
        (
          await fixture.prisma.user.findUnique({
            where: { id: account.user.id },
          })
        ).fullName,
        "Người dùng phiên",
      );
  });
});

test("storage events synchronize logout without BroadcastChannel and preserve only public metadata", async () => {
  const account = await seed();
  await withContext(
    async (context, page) => {
      await login(page, account);
      const second = await context.newPage();
      await second.goto(`${fixture.webOrigin}/account`, {
        waitUntil: "domcontentloaded",
      });
      await second
        .getByRole("heading", { name: "Người dùng phiên", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Đăng xuất", exact: true })
        .click();
      await second.waitForURL("**/login");
      const persisted = await page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }));
      const marker = JSON.parse(persisted.local["streamora.auth.revision"]);
      assert.deepEqual(Object.keys(marker).sort(), ["action", "id", "reason"]);
      assert.equal(marker.action, "signed-out");
      assert.deepEqual(persisted.session, {});
      assert.ok(!JSON.stringify(persisted).includes(account.email));
      assert.ok(!JSON.stringify(persisted).includes(PASSWORD));
    },
    () => {
      Object.defineProperty(window, "BroadcastChannel", {
        value: undefined,
        configurable: true,
      });
    },
  );
});

test("the expiry timer refreshes proactively while keeping the current user", async () => {
  const account = await seed();
  await withContext(async (_context, page) => {
    await page.clock.install({ time: new Date() });
    const sid = await login(page, account);
    const baseline = await tokens(sid),
      refreshes = countRefreshes(page);
    const response = page.waitForResponse(`${fixture.apiUrl}/auth/refresh`);
    await page.clock.fastForward(871000);
    assert.equal((await response).status(), 200);
    await page
      .getByRole("heading", { name: "Người dùng phiên", exact: true })
      .waitFor();
    assert.equal(refreshes(), 1);
    assert.equal(await tokens(sid), baseline + 1);
  });
});

test("a tab with delayed notifications cancels old-account mutations before dispatch", async () => {
  const first = await seed(),
    next = await seed();
  await withContext(async (context, page) => {
    // Simulate a suspended tab that missed cross-tab notifications, while shared metadata remains readable.
    await page.addInitScript(() => {
      Object.defineProperty(window, "BroadcastChannel", { value: undefined });
      const add = window.addEventListener.bind(window);
      window.addEventListener = (type, listener, options) => {
        if (!["storage", "focus", "pageshow"].includes(type))
          add(type, listener, options);
      };
      const addDocument = document.addEventListener.bind(document);
      document.addEventListener = (type, listener, options) => {
        if (type !== "visibilitychange") addDocument(type, listener, options);
      };
    });
    await login(page, first);
    await probe(page, first);
    const second = await context.newPage();
    await second.goto(`${fixture.webOrigin}/account`, {
      waitUntil: "domcontentloaded",
    });
    await second
      .getByRole("heading", { name: "Người dùng phiên", exact: true })
      .waitFor();
    await second
      .getByRole("button", { name: "Đăng xuất", exact: true })
      .click();
    await second.waitForURL("**/login");
    await login(second, next);
    assert.equal(await page.getByTestId("user").textContent(), first.email);
    let mutations = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH") mutations++;
    });
    await page.getByLabel("Tên thử nghiệm").fill("Không được ghi cho user mới");
    await page
      .getByRole("button", { name: "Gửi cập nhật" })
      .evaluate((button) => button.click());
    await result(page, "SESSION_CHANGED");
    assert.equal(mutations, 0);
    assert.equal(
      (await fixture.prisma.user.findUnique({ where: { id: next.user.id } }))
        .fullName,
      "Người dùng phiên",
    );
  });
});

test("profile updates and logout propagate to the workspace without overwriting an unchanged draft on focus", async () => {
  const account = await seed();
  await withContext(async (context, page) => {
    await login(page, account);
    const second = await context.newPage();
    await second.goto(`${fixture.webOrigin}/account`, {
      waitUntil: "domcontentloaded",
    });
    await second
      .getByRole("heading", { name: "Người dùng phiên", exact: true })
      .waitFor();
    await page
      .getByLabel("Họ và tên", { exact: true })
      .fill("Bản nháp chưa lưu");
    const validation = page.waitForResponse(`${fixture.apiUrl}/users/me`);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await validation;
    assert.equal(
      await page.getByLabel("Họ và tên", { exact: true }).inputValue(),
      "Bản nháp chưa lưu",
    );
    await second
      .getByLabel("Họ và tên", { exact: true })
      .fill("Tên đồng bộ giữa các tab");
    await second.getByRole("button", { name: "Lưu thay đổi" }).click();
    await page
      .getByRole("heading", { name: "Tên đồng bộ giữa các tab", exact: true })
      .waitFor();
    await page
      .getByRole("navigation", { name: "Điều hướng chính" })
      .getByRole("link", { name: "Không gian học tập", exact: true })
      .click();
    await page.waitForURL("**/workspace");
    assert.equal(
      await page.locator(".sidebar-user b").textContent(),
      "Tên đồng bộ giữa các tab",
    );
    await second
      .getByRole("button", { name: "Đăng xuất", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector(".sidebar-user b")?.textContent === "Khách",
    );
    await page
      .getByRole("status")
      .filter({ hasText: "Bạn đã đăng xuất ở tab khác." })
      .waitFor();
  });
});

test("BroadcastChannel still synchronizes logout when localStorage is blocked", async () => {
  const account = await seed();
  await withContext(
    async (context, page) => {
      await login(page, account);
      const second = await context.newPage();
      await second.goto(`${fixture.webOrigin}/account`, {
        waitUntil: "domcontentloaded",
      });
      await second
        .getByRole("heading", { name: "Người dùng phiên", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Đăng xuất", exact: true })
        .click();
      await second.waitForURL("**/login");
    },
    () => {
      Storage.prototype.getItem = () => {
        throw new DOMException("Blocked", "SecurityError");
      };
      Storage.prototype.setItem = () => {
        throw new DOMException("Blocked", "SecurityError");
      };
    },
  );
});

test("a browser without Web Locks gets a clear error instead of an unsafe cookie refresh", async () => {
  await withContext(
    async (_context, page) => {
      let cookieRequests = 0;
      page.on("request", (request) => {
        if (request.url().startsWith(`${fixture.apiUrl}/auth/`))
          cookieRequests++;
      });
      await page.goto(`${fixture.webOrigin}/login`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .getByRole("alert")
        .filter({ hasText: "Trình duyệt chưa hỗ trợ đồng bộ phiên an toàn." })
        .waitFor();
      await page
        .getByLabel("Email", { exact: true })
        .fill("browser@example.test");
      await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD);
      await page
        .getByRole("button", { name: "Đăng nhập", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Trình duyệt chưa hỗ trợ đồng bộ phiên an toàn." })
        .waitFor();
      assert.equal(cookieRequests, 0);
    },
    () => {
      Object.defineProperty(navigator, "locks", { value: undefined });
    },
  );
});

test("failed BroadcastChannel postMessage cannot turn successful login/logout into an error", async () => {
  const account = await seed();
  await withContext(
    async (context, page) => {
      await login(page, account);
      const second = await context.newPage();
      await second.goto(`${fixture.webOrigin}/account`, {
        waitUntil: "domcontentloaded",
      });
      await second
        .getByRole("heading", { name: "Người dùng phiên", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Đăng xuất", exact: true })
        .click();
      await Promise.all([
        page.waitForURL("**/login"),
        second.waitForURL("**/login"),
      ]);
      await page
        .getByRole("status")
        .filter({ hasText: "Bạn đã đăng xuất thành công." })
        .waitFor();
    },
    () => {
      const NativeChannel = window.BroadcastChannel;
      window.BroadcastChannel = class extends NativeChannel {
        postMessage() {
          throw new DOMException("Blocked", "InvalidStateError");
        }
      };
    },
  );
});
