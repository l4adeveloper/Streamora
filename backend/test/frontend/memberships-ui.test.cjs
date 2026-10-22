const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");
let fixture, browser;
const password = "Membership-ui-password-123!";
before(
  async () => {
    browser = await chromium.launch({
      headless: true,
      channel:
        process.env.STREAMORA_TEST_BROWSER_CHANNEL ??
        (process.platform === "win32" ? "msedge" : undefined),
    });
    fixture = await createFrontendFixture();
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

async function api(actor, method, path, body) {
  const response = await fetch(`${fixture.apiUrl}${path}`, {
    method,
    headers: {
      Origin: fixture.webOrigin,
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}
async function account(fullName) {
  const email = `t03-ui-${randomUUID()}@example.test`;
  assert.equal(
    (await api(null, "POST", "/auth/register", { email, password, fullName }))
      .status,
    201,
  );
  const response = await api(null, "POST", "/auth/login", { email, password });
  return { ...response.body.user, email, token: response.body.accessToken };
}
async function contextFor(actor) {
  const context = await browser.newContext();
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${fixture.webOrigin}/login`);
  await page.getByLabel("Email", { exact: true }).fill(actor.email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.waitForURL("**/account");
  return { context, page };
}
async function seed() {
  const owner = await account("Chủ nhóm T03"),
    viewer = await account("Nguyễn Minh Anh");
  const created = await api(owner, "POST", "/groups", {
    name: `Nhóm học T03 ${randomUUID().slice(0, 6)}`,
  });
  assert.equal(created.status, 201);
  return { owner, viewer, group: created.body.group };
}
async function members(page, groupId) {
  await page.goto(`${fixture.webOrigin}/workspace?groupId=${groupId}`);
  await page
    .getByRole("button", { name: "Thành viên", exact: true })
    .first()
    .click();
  await page.locator(".membership-person b").first().waitFor();
}

test("owner manages real members from the workspace sidebar, including exact-email errors and protected owner", async () => {
  const { owner, viewer, group } = await seed();
  const { context, page } = await contextFor(owner);
  try {
    await members(page, group.id);
    await page.getByText(owner.email, { exact: true }).waitFor();
    assert.equal(
      await page
        .getByLabel(`Xóa ${owner.fullName} khỏi nhóm`, { exact: true })
        .count(),
      0,
    );
    await page
      .getByLabel("Email thành viên mới", { exact: true })
      .fill("missing-person@example.test");
    await page
      .getByRole("button", { name: "Thêm thành viên", exact: true })
      .click();
    await page
      .getByText("Không tồn tại người dùng với email này.", { exact: true })
      .waitFor();
    await page
      .getByLabel("Email thành viên mới", { exact: true })
      .fill(viewer.email.toUpperCase());
    await page
      .getByLabel("Vai trò thành viên mới", { exact: true })
      .selectOption("HOST");
    await page
      .getByRole("button", { name: "Thêm thành viên", exact: true })
      .click();
    await page.getByText(viewer.email, { exact: true }).waitFor();
    assert.equal(
      (
        await fixture.prisma.groupMember.findUnique({
          where: { userId_groupId: { userId: viewer.id, groupId: group.id } },
        })
      ).role,
      "HOST",
    );
    while (
      await page
        .getByRole("button", { name: "Đóng thông báo", exact: true })
        .count()
    )
      await page
        .getByRole("button", { name: "Đóng thông báo", exact: true })
        .first()
        .click();
    await page.screenshot({
      path: join(fixture.previewRoot, "t03-members-desktop.png"),
      fullPage: true,
    });
    const search = page.getByRole("textbox", {
      name: "Tìm thành viên theo tên hoặc email",
    });
    await search.fill("Minh Anh");
    await page.waitForFunction(
      () => document.querySelectorAll(".membership-person").length === 1,
    );
    assert.equal(await page.getByText(owner.email, { exact: true }).count(), 0);
    await search.fill(viewer.email);
    await page.getByText(viewer.email, { exact: true }).waitFor();
    await page
      .getByLabel(`Vai trò của ${viewer.fullName}`, { exact: true })
      .selectOption("VIEWER");
    await page.waitForFunction(
      () =>
        document.querySelector(".membership-controls select")?.value ===
        "VIEWER",
    );
    await page
      .getByLabel(`Xóa ${viewer.fullName} khỏi nhóm`, { exact: true })
      .click();
    await page.getByRole("button", { name: "Hủy", exact: true }).click();
    assert.equal(
      await fixture.prisma.groupMember.count({
        where: { userId: viewer.id, groupId: group.id },
      }),
      1,
    );
    await page
      .getByLabel(`Xóa ${viewer.fullName} khỏi nhóm`, { exact: true })
      .click();
    await page
      .getByRole("button", { name: "Xác nhận xóa", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Không tìm thấy thành viên" })
      .waitFor();
    assert.equal(
      await fixture.prisma.groupMember.count({
        where: { userId: viewer.id, groupId: group.id },
      }),
      0,
    );
    await search.fill("");
    await page.getByText(owner.email, { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    while (
      await page
        .getByRole("button", { name: "Đóng thông báo", exact: true })
        .count()
    )
      await page
        .getByRole("button", { name: "Đóng thông báo", exact: true })
        .first()
        .click();
    await page.screenshot({
      path: join(fixture.previewRoot, "t03-members-mobile.png"),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("viewer sees names/emails, cannot manage members, and loses open access on a realtime removal", async () => {
  const { owner, viewer, group } = await seed();
  assert.equal(
    (
      await api(owner, "POST", `/groups/${group.id}/members`, {
        userId: viewer.id,
        role: "VIEWER",
      })
    ).status,
    201,
  );
  const { context, page } = await contextFor(viewer);
  try {
    await members(page, group.id);
    await page.getByText(owner.email, { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Email thành viên mới", { exact: true }).count(),
      0,
    );
    assert.equal(await page.locator(".membership-controls").count(), 0);
    await page
      .getByRole("button", { name: "Quay lại không gian", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Ghi hình", exact: true })
        .isDisabled(),
      true,
    );
    await api(owner, "PATCH", `/groups/${group.id}/members/${viewer.id}`, {
      role: "HOST",
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.textContent.trim() === "Ghi hình" && !button.disabled,
      ),
    );
    await api(owner, "PATCH", `/groups/${group.id}/members/${viewer.id}`, {
      role: "VIEWER",
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "Ghi hình" && button.disabled,
      ),
    );
    await page
      .getByRole("button", { name: "Thành viên", exact: true })
      .first()
      .click();
    await page.getByText(owner.email, { exact: true }).waitFor();
    await api(owner, "DELETE", `/groups/${group.id}/members/${viewer.id}`);
    await page
      .getByRole("heading", { name: "Bạn chưa có quyền truy cập" })
      .waitFor({ timeout: 7000 });
    assert.equal(await page.locator(".membership-person").count(), 0);
  } finally {
    await context.close();
  }
});

test("search discards stale results; pagination and group selection never mix member lists", async () => {
  const { owner, viewer, group } = await seed();
  await api(owner, "POST", `/groups/${group.id}/members`, {
    userId: viewer.id,
    role: "VIEWER",
  });
  for (let index = 0; index < 22; index++) {
    const person = await fixture.prisma.user.create({
      data: {
        email: `member-${index}-${randomUUID()}@example.test`,
        fullName: `Thành viên phụ ${index}`,
        passwordHash: "$argon2id$ui-fixture-not-loginable",
      },
    });
    await fixture.prisma.groupMember.create({
      data: { userId: person.id, groupId: group.id, role: "VIEWER" },
    });
  }
  const other = await api(owner, "POST", "/groups", {
    name: `Nhóm riêng ${randomUUID()}`,
  });
  const { context, page } = await contextFor(owner);
  let release;
  try {
    await members(page, group.id);
    assert.equal(await page.locator(".membership-person").count(), 20);
    // A group opened through a deep link remains selected in the shared file/
    // recording workspace, even when it is not the newest group in the list.
    await page.goto(`${fixture.webOrigin}/files`);
    await page.waitForFunction(
      (expected) =>
        document.querySelector('select[aria-label="Chọn nhóm học tập"]')
          ?.value === expected,
      group.id,
    );
    await page
      .getByRole("button", { name: "Thành viên", exact: true })
      .first()
      .click();
    await page.locator(".membership-person").first().waitFor();
    await page
      .getByRole("button", { name: "Xem thêm thành viên", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".membership-person").length === 24,
    );
    let started;
    const received = new Promise((resolve) => {
      started = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/members?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("q") !== "old-query")
        return route.continue();
      const response = await route.fetch();
      started();
      await blocked;
      await route.fulfill({ response });
    });
    const search = page.getByRole("textbox", {
      name: "Tìm thành viên theo tên hoặc email",
    });
    await search.fill("old-query");
    await received;
    await search.fill(viewer.email);
    await page.getByText(viewer.email, { exact: true }).waitFor();
    release();
    await page.waitForTimeout(350);
    assert.equal(await page.locator(".membership-person").count(), 1);
    await page
      .getByLabel("Chọn nhóm học tập", { exact: true })
      .selectOption(other.body.group.id);
    await page.getByText(owner.email, { exact: true }).waitFor();
    assert.equal(
      await page.getByText(viewer.email, { exact: true }).count(),
      0,
    );
  } finally {
    release?.();
    await context.close();
  }
});
