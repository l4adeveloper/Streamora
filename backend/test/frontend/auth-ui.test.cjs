const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");

let fixture, browser;
const PASSWORD = "Frontend-only-password-123!";
const uniqueEmail = () => `ui-${randomUUID()}@example.test`;

before(
  async () => {
    browser = await chromium.launch({
      headless: true,
      channel:
        process.env.STREAMORA_TEST_BROWSER_CHANNEL ??
        (process.platform === "win32" ? "msedge" : undefined),
    });
    fixture = await createFrontendFixture({ shellProbe: true });
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

async function withPage(run, viewport = { width: 1440, height: 960 }) {
  const context = await browser.newContext({ viewport });
  // Use the system fallback font in test, without relying on third-party network access.
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.abort(),
  );
  try {
    await run(await context.newPage(), context);
  } finally {
    await context.close();
  }
}
async function open(page, path) {
  await page.goto(`${fixture.webOrigin}${path}`, {
    waitUntil: "domcontentloaded",
  });
}
async function waitForButton(page, name) {
  const button = page.getByRole("button", { name, exact: true });
  await button.waitFor();
  await page.waitForFunction(
    (name) =>
      Array.from(document.querySelectorAll("button")).some(
        (button) =>
          button.textContent.trim() === name &&
          !button.disabled &&
          !button.closest("fieldset")?.disabled,
      ),
    name,
  );
  return button;
}
async function fillLogin(page, email, password = PASSWORD) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
}
async function seed(email = uniqueEmail()) {
  const response = await fetch(`${fixture.apiUrl}/auth/register`, {
    method: "POST",
    headers: { Origin: fixture.webOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      fullName: "Nguyễn Minh Anh",
    }),
  });
  assert.equal(response.status, 201);
  return { email, user: (await response.json()).user };
}

test("real UI registers once, logs in, loads/updates the profile, restores after reload and logs out", async () => {
  await withPage(async (page) => {
    const email = uniqueEmail();
    await open(page, "/register");
    const submit = await waitForButton(page, "Tạo tài khoản");
    await page.screenshot({
      path: join(fixture.previewRoot, "auth-register-desktop.png"),
      fullPage: true,
    });
    await page
      .getByLabel("Họ và tên", { exact: true })
      .fill("  Nguyễn Minh Anh  ");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD);
    let registrations = 0;
    await page.route(`${fixture.apiUrl}/auth/register`, async (route) => {
      registrations++;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await submit.evaluate((button) => {
      button.click();
      button.click();
    });
    await page.getByRole("button", { name: "Đang tạo tài khoản…" }).waitFor();
    assert.equal(
      await page.getByLabel("Email", { exact: true }).isDisabled(),
      true,
    );
    await page
      .getByRole("heading", { name: "Tạo tài khoản thành công!" })
      .waitFor();
    assert.equal(registrations, 1);
    assert.equal(await fixture.prisma.user.count({ where: { email } }), 1);
    await page.getByRole("link", { name: "Đăng nhập ngay" }).click();
    await waitForButton(page, "Đăng nhập");
    await fillLogin(page, email);
    const loginResponse = page.waitForResponse(`${fixture.apiUrl}/auth/login`);
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    const oldToken = (await (await loginResponse).json()).accessToken;
    await page.waitForURL("**/account");
    await page
      .getByRole("heading", { name: "Nguyễn Minh Anh", exact: true })
      .waitFor();
    const name = page.getByLabel("Họ và tên", { exact: true });
    assert.equal(
      await page.getByLabel("Email", { exact: true }).getAttribute("readonly"),
      "",
    );
    await name.fill("Họ tên đã cập nhật");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Đã cập nhật họ và tên." })
      .waitFor();
    assert.equal(
      (await fixture.prisma.user.findUnique({ where: { email } })).fullName,
      "Họ tên đã cập nhật",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: "Họ tên đã cập nhật", exact: true })
      .waitFor();
    await page.screenshot({
      path: join(fixture.previewRoot, "auth-account-desktop.png"),
      fullPage: true,
    });
    const storage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }));
    assert.deepEqual(Object.keys(storage.local), ["streamora.auth.revision"]);
    assert.deepEqual(storage.session, {});
    for (const privateValue of [oldToken, PASSWORD, email])
      assert.ok(!JSON.stringify(storage).includes(privateValue));
    await page.getByRole("button", { name: "Đăng xuất", exact: true }).click();
    await page.waitForURL("**/login");
    await page
      .getByRole("status")
      .filter({ hasText: "Bạn đã đăng xuất thành công." })
      .waitFor();
    assert.equal(
      (
        await fetch(`${fixture.apiUrl}/users/me`, {
          headers: { Authorization: `Bearer ${oldToken}` },
        })
      ).status,
      401,
    );
    await open(page, "/account");
    await page.waitForURL("**/login");
    assert.equal(
      await page
        .getByRole("heading", { name: "Họ tên đã cập nhật", exact: true })
        .count(),
      0,
    );
  });
});

test("forms show field errors, duplicate-email errors and incorrect-login errors", async () => {
  const registered = await seed();
  await withPage(async (page) => {
    await open(page, "/register");
    await (await waitForButton(page, "Tạo tài khoản")).click();
    await page.getByText("Vui lòng nhập họ và tên.", { exact: true }).waitFor();
    await page.getByText("Vui lòng nhập email.", { exact: true }).waitFor();
    await page.getByText("Vui lòng nhập mật khẩu.", { exact: true }).waitFor();
    await page.getByLabel("Họ và tên", { exact: true }).fill("Người kiểm thử");
    await fillLogin(page, registered.email, "short");
    await page
      .getByRole("button", { name: "Tạo tài khoản", exact: true })
      .click();
    await page
      .getByText("Mật khẩu cần ít nhất 12 ký tự.", { exact: true })
      .waitFor();
    await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD);
    await page
      .getByRole("button", { name: "Tạo tài khoản", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Email này đã được sử dụng" })
      .waitFor();
    assert.equal(
      await page
        .getByLabel("Email", { exact: true })
        .getAttribute("aria-invalid"),
      "true",
    );
    await page
      .getByRole("link", { name: "Đăng nhập", exact: true })
      .first()
      .click();
    await waitForButton(page, "Đăng nhập");
    await fillLogin(page, registered.email, "wrong-password-123!");
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Email hoặc mật khẩu không đúng" })
      .waitFor();
    assert.ok(page.url().endsWith("/login"));
  });
});

test("login handles disabled accounts and rate-limit responses without revealing private data", async () => {
  const registered = await seed();
  await fixture.prisma.user.update({
    where: { id: registered.user.id },
    data: { disabledAt: new Date() },
  });
  await withPage(async (page) => {
    await open(page, "/login");
    await waitForButton(page, "Đăng nhập");
    await fillLogin(page, registered.email);
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Tài khoản đã bị khóa" })
      .waitFor();
    await page.route(`${fixture.apiUrl}/auth/login`, (route) =>
      route.fulfill({
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": fixture.webOrigin,
          "Access-Control-Allow-Credentials": "true",
          "Retry-After": "42",
          "Access-Control-Expose-Headers": "Retry-After",
        },
        body: JSON.stringify({
          error: { code: "RATE_LIMITED", message: "Rate limited" },
          requestId: randomUUID(),
        }),
      }),
    );
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Vui lòng thử lại sau 42 giây." })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Đăng nhập", exact: true })
        .isEnabled(),
      true,
    );
  });
});

test("account validates name changes and keeps the session available when logout loses network", async () => {
  const registered = await seed();
  await withPage(async (page) => {
    await open(page, "/login");
    await waitForButton(page, "Đăng nhập");
    await fillLogin(page, registered.email);
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await page.waitForURL("**/account");
    await page.getByLabel("Họ và tên", { exact: true }).fill("   ");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await page.getByText("Vui lòng nhập họ và tên.", { exact: true }).waitFor();
    await page.getByLabel("Họ và tên", { exact: true }).fill("x".repeat(101));
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await page
      .getByText("Họ và tên không được quá 100 ký tự.", { exact: true })
      .waitFor();
    await page.route(`${fixture.apiUrl}/auth/logout`, (route) => route.abort());
    await page.getByRole("button", { name: "Đăng xuất", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Không thể kết nối đến máy chủ" })
      .waitFor();
    assert.ok(page.url().endsWith("/account"));
    assert.equal(
      await fixture.prisma.authSession.count({
        where: { userId: registered.user.id, revokedAt: null },
      }),
      1,
    );
    await page.unroute(`${fixture.apiUrl}/auth/logout`);
    await page.getByRole("button", { name: "Đăng xuất", exact: true }).click();
    await page.waitForURL("**/login");
  });
});

test("mobile forms fit the viewport, support password visibility and recover from API network errors", async () => {
  await withPage(
    async (page) => {
      await open(page, "/login");
      await waitForButton(page, "Đăng nhập");
      await page.screenshot({
        path: join(fixture.previewRoot, "auth-login-mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await fillLogin(page, uniqueEmail());
      await page
        .getByRole("button", { name: "Hiện mật khẩu", exact: true })
        .click();
      assert.equal(
        await page.getByLabel("Mật khẩu", { exact: true }).getAttribute("type"),
        "text",
      );
      await page
        .getByRole("button", { name: "Ẩn mật khẩu", exact: true })
        .click();
      await page.route(`${fixture.apiUrl}/auth/login`, (route) =>
        route.abort(),
      );
      await page
        .getByRole("button", { name: "Đăng nhập", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Không thể kết nối đến máy chủ" })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Đăng nhập", exact: true })
          .isEnabled(),
        true,
      );
    },
    { width: 390, height: 844 },
  );
});

async function loginForShell(page) {
  const account = await seed();
  await open(page, "/login");
  await waitForButton(page, "Đăng nhập");
  await fillLogin(page, account.email);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.waitForURL("**/account");
  await page
    .getByRole("heading", { name: "Nguyễn Minh Anh", exact: true })
    .waitFor();
  return account;
}

async function openAuthenticatedShell(page) {
  await open(page, "/shell-probe");
  // Full navigation starts a fresh tab store; wait for cookie restoration before mocks/actions.
  await page
    .getByRole("navigation", { name: "Điều hướng chính" })
    .getByRole("link", { name: "Tài khoản", exact: true })
    .waitFor();
}

test("shared toasts queue, pause, survive navigation and dismiss; error notices stay visible", async () => {
  await withPage(async (page) => {
    await open(page, "/shell-probe");
    await page.getByRole("heading", { name: "Giao diện dùng chung" }).waitFor();
    await page.clock.install();
    for (let i = 0; i < 4; i++)
      await page.getByRole("button", { name: "Thêm thông báo" }).click();
    const stack = page.getByRole("region", { name: "Thông báo", exact: true });
    assert.equal(await stack.getByRole("status").count(), 3);
    assert.ok(!(await stack.textContent()).includes("Thông báo 1"));
    await stack.getByRole("status").filter({ hasText: "Thông báo 2" }).hover();
    await page.clock.fastForward(6000);
    await page.waitForFunction(
      () => document.querySelectorAll(".app-toast").length === 1,
    );
    assert.ok((await stack.textContent()).includes("Thông báo 2"));
    await page.getByRole("link", { name: "Về trang chủ thử nghiệm" }).click();
    await page.waitForURL(fixture.webOrigin + "/");
    assert.equal(await stack.getByRole("status").count(), 1);
    await stack.getByRole("button", { name: "Đóng thông báo" }).click();
    assert.equal(await stack.getByRole("status").count(), 0);
    await open(page, "/shell-probe");
    await page
      .getByRole("button", { name: "Thông báo lỗi", exact: true })
      .click();
    await page.clock.fastForward(60000);
    await stack
      .getByRole("alert")
      .filter({ hasText: "Lỗi cần xem lại." })
      .waitFor();
    await stack.getByRole("button", { name: "Đóng thông báo" }).click();
    assert.equal(await stack.getByRole("alert").count(), 0);
  });
});

test("shared form maps feature field errors, links hints and errors, and prevents duplicate pending submits", async () => {
  await withPage(async (page) => {
    await loginForShell(page);
    await openAuthenticatedShell(page);
    let writes = 0,
      release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(fixture.apiUrl + "/users/me", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      writes++;
      await gate;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: {
              fields: [{ field: "title", message: "Tiêu đề đã tồn tại." }],
            },
          },
        }),
      });
    });
    const title = page.getByLabel("Tiêu đề", { exact: true });
    await title.fill("Tên thử nghiệm");
    await page
      .getByRole("button", { name: "Ghi biểu mẫu" })
      .evaluate((button) => {
        button.click();
        button.click();
      });
    await page.getByRole("button", { name: "Đang gửi biểu mẫu…" }).waitFor();
    assert.equal(await title.isDisabled(), true);
    release();
    await page.getByText("Tiêu đề đã tồn tại.", { exact: true }).waitFor();
    assert.equal(writes, 1);
    assert.equal(await title.getAttribute("aria-invalid"), "true");
    assert.equal(
      await title.getAttribute("aria-describedby"),
      "probe-title-hint probe-title-error",
    );
    assert.equal(await title.isEnabled(), true);
  });
});

test("shared request error keeps the session on 403 and offers retry for server failures", async () => {
  await withPage(async (page) => {
    await loginForShell(page);
    await openAuthenticatedShell(page);
    let status = 403,
      refreshes = 0,
      reads = 0;
    page.on("request", (request) => {
      if (request.url() === fixture.apiUrl + "/auth/refresh") refreshes++;
    });
    await page.route(fixture.apiUrl + "/users/me", async (route) => {
      reads++;
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "FEATURE_SPECIFIC_ERROR",
            message: "PRIVATE_ERROR_SAMPLE_DO_NOT_RENDER",
          },
        }),
      });
    });
    await page.getByRole("button", { name: "Đọc tài nguyên" }).click();
    await page
      .getByRole("heading", { name: "Bạn chưa có quyền truy cập" })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Thử lại", exact: true }).count(),
      0,
    );
    assert.equal(refreshes, 0);
    assert.ok(
      !(await page.locator("body").textContent()).includes(
        "PRIVATE_ERROR_SAMPLE_DO_NOT_RENDER",
      ),
    );
    assert.equal(
      await page
        .getByRole("navigation", { name: "Điều hướng chính" })
        .getByRole("link", { name: "Tài khoản", exact: true })
        .count(),
      1,
    );
    status = 500;
    await page.getByRole("button", { name: "Đọc tài nguyên" }).click();
    await page.getByRole("button", { name: "Thử lại", exact: true }).waitFor();
    assert.equal(reads, 2);
    await page.getByRole("button", { name: "Thử lại", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("button[disabled]"),
    );
    assert.equal(reads, 3);
    assert.equal(refreshes, 0);
  });
});

test("account changes clear shared toasts so private notices do not follow logout", async () => {
  await withPage(async (page) => {
    await loginForShell(page);
    await openAuthenticatedShell(page);
    await page
      .getByRole("button", { name: "Thông báo lỗi", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Lỗi cần xem lại." })
      .waitFor();
    await page
      .getByRole("navigation", { name: "Điều hướng chính" })
      .getByRole("link", { name: "Tài khoản", exact: true })
      .click();
    await page.waitForURL("**/account");
    assert.equal(
      await page
        .getByRole("alert")
        .filter({ hasText: "Lỗi cần xem lại." })
        .count(),
      1,
    );
    await page.getByRole("button", { name: "Đăng xuất", exact: true }).click();
    await page.waitForURL("**/login");
    assert.equal(
      await page
        .getByRole("alert")
        .filter({ hasText: "Lỗi cần xem lại." })
        .count(),
      0,
    );
  });
});

test("shared shell handles unknown routes and recovers from render errors without exposing error text", async () => {
  await withPage(async (page) => {
    const response = await page.goto(
      fixture.webOrigin + "/unknown-shell-route",
      { waitUntil: "domcontentloaded" },
    );
    assert.equal(response.status(), 404);
    await page
      .getByRole("heading", { name: "Không gian này chưa tồn tại." })
      .waitFor();
    await page.getByRole("navigation", { name: "Điều hướng chính" }).waitFor();
    await open(page, "/shell-crash");
    await page.getByRole("button", { name: "Tạo lỗi render" }).click();
    await page
      .getByRole("heading", { name: "Nội dung đang bị gián đoạn" })
      .waitFor();
    assert.ok(
      !(await page.locator("body").textContent()).includes(
        "PRIVATE_ERROR_SAMPLE_DO_NOT_RENDER",
      ),
    );
    await page.getByRole("button", { name: "Thử lại", exact: true }).click();
    await page.getByRole("button", { name: "Tạo lỗi render" }).waitFor();
  });
});

test("shared shell and form controls fit mobile screens", async () => {
  await withPage(
    async (page) => {
      await open(page, "/shell-probe");
      await page
        .getByRole("heading", { name: "Giao diện dùng chung" })
        .waitFor();
      await page
        .getByRole("button", { name: "Thông báo lỗi", exact: true })
        .click();
      await page.screenshot({
        path: join(fixture.previewRoot, "shared-shell-mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    },
    { width: 390, height: 844 },
  );
});
