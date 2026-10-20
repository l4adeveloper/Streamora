const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { mkdir } = require("node:fs/promises");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

// This runner is deliberately restricted to the separate local staging stack.
const origin = "https://localhost:8443";
let browser,
  context,
  step = "khởi động browser",
  passed = 0;
async function check(name, run) {
  step = name;
  await run();
  passed++;
  console.log(`PASS ${name}`);
}

(async () => {
  browser = await chromium.launch({
    headless: true,
    channel: process.platform === "win32" ? "msedge" : undefined,
  });
  // Scope the self-signed certificate exception to this isolated context only.
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const api = `${origin}/api/v1`;
  const email = `stage-${randomUUID()}@example.test`;
  const password = `Stage-${randomBytes(24).toString("base64url")}!`;
  let token;
  await check("health qua HTTPS proxy", async () => {
    assert.equal((await context.request.get(`${api}/health`)).status(), 200);
  });
  await check("Swagger tắt ở production", async () => {
    for (const path of ["/docs", "/docs-json", "/docs/swagger-ui-init.js"])
      assert.equal((await context.request.get(api + path)).status(), 404);
  });
  await check("guard chặn người chưa đăng nhập", async () => {
    assert.equal((await context.request.get(`${api}/users/me`)).status(), 401);
  });
  await check("Origin sai bị chặn", async () => {
    const response = await context.request.post(`${api}/auth/register`, {
      headers: { Origin: "https://other.invalid" },
      data: { email, password, fullName: "Kiểm thử staging" },
    });
    assert.equal(response.status(), 403);
    assert.equal((await response.json()).error.code, "ORIGIN_NOT_ALLOWED");
  });
  await check("đăng ký từ frontend production", async () => {
    await page.goto(`${origin}/register`);
    await page
      .getByLabel("Họ và tên", { exact: true })
      .fill("Kiểm thử staging");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    const response = page.waitForResponse(
      (r) =>
        r.url() === `${api}/auth/register` && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Tạo tài khoản", exact: true })
      .click();
    assert.equal((await response).status(), 201);
    await page
      .getByRole("heading", { name: "Tạo tài khoản thành công!" })
      .waitFor();
  });
  await check("login và trang tài khoản", async () => {
    await page.getByRole("link", { name: "Đăng nhập ngay" }).click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    const response = page.waitForResponse(
      (r) => r.url() === `${api}/auth/login` && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    const login = await response;
    assert.equal(login.status(), 200);
    token = (await login.json()).accessToken;
    await page.waitForURL(`${origin}/account`);
    await page
      .getByRole("heading", { name: "Kiểm thử staging", exact: true })
      .waitFor();
  });
  await check("cookie Secure HttpOnly và bearer thật", async () => {
    const cookies = await context.cookies(`${api}/auth/refresh`);
    const refresh = cookies.find((c) => c.path === "/api/v1/auth");
    assert.ok(refresh?.secure && refresh.httpOnly);
    assert.equal(refresh.sameSite, "Lax");
    assert.equal(
      (
        await context.request.get(`${api}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status(),
      200,
    );
  });
  await check("sửa hồ sơ Unicode", async () => {
    await page
      .getByLabel("Họ và tên", { exact: true })
      .fill("Họ tên staging đã cập nhật");
    const response = page.waitForResponse(
      (r) => r.url() === `${api}/users/me` && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    const saved = await response;
    assert.equal(saved.status(), 200);
    assert.equal(
      (await saved.json()).user.fullName,
      "Họ tên staging đã cập nhật",
    );
  });
  await check("reload khôi phục phiên và xoay cookie", async () => {
    const before = (await context.cookies(`${api}/auth/refresh`)).find(
      (c) => c.path === "/api/v1/auth",
    ).value;
    await page.reload();
    await page
      .getByRole("heading", { name: "Họ tên staging đã cập nhật", exact: true })
      .waitFor();
    const after = (await context.cookies(`${api}/auth/refresh`)).find(
      (c) => c.path === "/api/v1/auth",
    ).value;
    assert.notEqual(after, before);
    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    );
    assert.ok(
      !storage.includes(token) &&
        !storage.includes(password) &&
        !storage.includes(email),
    );
    await mkdir(resolve(".preview"), { recursive: true });
    await page.screenshot({
      path: resolve(".preview/t01-staging-account.png"),
      fullPage: true,
    });
  });
  const second = await context.newPage();
  await check("tab thứ hai khôi phục phiên", async () => {
    await second.goto(`${origin}/account`);
    await second
      .getByRole("heading", { name: "Họ tên staging đã cập nhật", exact: true })
      .waitFor();
  });
  await check("logout đồng bộ hai tab và vô hiệu bearer", async () => {
    await page.getByRole("button", { name: "Đăng xuất", exact: true }).click();
    await Promise.all([
      page.waitForURL(`${origin}/login`),
      second.waitForURL(`${origin}/login`),
    ]);
    assert.equal(
      (
        await context.request.get(`${api}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status(),
      401,
    );
    assert.equal(
      (await context.cookies(`${api}/auth/refresh`)).filter(
        (c) => c.path === "/api/v1/auth",
      ).length,
      0,
    );
    assert.equal(
      (
        await context.request.post(`${api}/auth/refresh`, {
          headers: { Origin: origin },
        })
      ).status(),
      401,
    );
  });
  console.log(
    `STAGING_T01_OK ${passed} bước; chỉ database staging có thêm một user thử đã logout.`,
  );
})()
  .catch(() => {
    console.error(`STAGING_T01_FAILED tại bước: ${step}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (context) {
      await context.request
        .post(`${origin}/api/v1/auth/logout`, { headers: { Origin: origin } })
        .catch(() => {});
      await context.close();
    }
    if (browser) await browser.close();
  });
