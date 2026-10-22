const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");

let fixture, browser;
const PASSWORD = "Groups-test-password-123!";

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

async function withGroups(run) {
  const context = await browser.newContext();
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.abort(),
  );
  try {
    const email = `groups-${randomUUID()}@example.test`;
    const registered = await fetch(`${fixture.apiUrl}/auth/register`, {
      method: "POST",
      headers: {
        Origin: fixture.webOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password: PASSWORD,
        fullName: "Người kiểm thử nhóm",
      }),
    });
    assert.equal(registered.status, 201);
    const user = (await registered.json()).user;
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`${fixture.webOrigin}/login`);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await page.waitForURL("**/workspace");
    await page.goto(`${fixture.webOrigin}/groups`);
    await page.getByText("Chưa có nhóm học tập nào", { exact: true }).waitFor();
    await run(page, user);
  } finally {
    await context.close();
  }
}

test("group UI retries a lost create response with the same key and clears an existing description", async () => {
  await withGroups(async (page, user) => {
    const keys = [];
    await page.route("**/api/v1/groups", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length === 1) {
        await route.fetch();
        return route.abort();
      }
      return route.continue();
    });
    await page
      .getByRole("button", { name: "Tạo nhóm mới", exact: true })
      .click();
    await page
      .getByLabel("Tên nhóm học tập", { exact: true })
      .fill("Nhóm kiểm thử");
    await page.getByLabel("Mô tả nhóm (tuỳ chọn)").fill("Mô tả cũ");
    await page.getByRole("button", { name: "Tạo nhóm", exact: true }).click();
    await page
      .getByText(
        "Không thể kết nối đến máy chủ. Vui lòng kiểm tra kết nối và thử lại.",
        { exact: true },
      )
      .waitFor();
    await page.getByRole("button", { name: "Tạo nhóm", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.ok(keys[0]);
    assert.equal(keys[0], keys[1]);
    assert.equal(
      await fixture.prisma.group.count({ where: { ownerId: user.id } }),
      1,
    );

    await page
      .getByRole("link", { name: "Nhóm kiểm thử", exact: true })
      .click();
    await page.getByRole("button", { name: "Chỉnh sửa", exact: true }).click();
    await page.getByLabel("Mô tả nhóm (tuỳ chọn)").fill("");
    await page
      .getByRole("button", { name: "Lưu thay đổi", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page
      .getByText("Chưa có mô tả chi tiết cho nhóm này.", { exact: true })
      .waitFor();
    assert.equal(
      (await fixture.prisma.group.findFirst({ where: { ownerId: user.id } }))
        .description,
      "",
    );
    assert.equal(
      await page
        .getByRole("link", { name: "Quản lý thành viên", exact: true })
        .getAttribute("href"),
      `/workspace?groupId=${(await fixture.prisma.group.findFirst({ where: { ownerId: user.id } })).id}&tab=members`,
    );
    await page.getByRole("button", { name: "Xóa nhóm", exact: true }).click();
    await page
      .getByRole("button", { name: "Xác nhận xóa", exact: true })
      .click();
    await page.waitForURL("**/groups");
    await page.getByText("Chưa có nhóm học tập nào", { exact: true }).waitFor();
  });
});

test("search ignores older responses, cancels pending debounce and refreshes the active filter after create/edit", async () => {
  await withGroups(async (page, user) => {
    const search = page.getByRole("textbox", { name: "Tìm kiếm nhóm" });
    const group = (name) => ({
      id: randomUUID(),
      name,
      description: null,
      ownerId: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let releaseOld, oldReceived;
    const oldStarted = new Promise((resolve) => {
      oldReceived = resolve;
    });
    const oldResponse = new Promise((resolve) => {
      releaseOld = resolve;
    });
    await page.route("**/api/v1/groups?**", async (route) => {
      const q = new URL(route.request().url()).searchParams.get("q");
      if (q !== "Old" && q !== "New") return route.continue();
      if (q === "Old") {
        oldReceived();
        await oldResponse;
      }
      await route.fulfill({
        json: { items: [group(`${q} result`)], nextCursor: null },
      });
    });
    await search.fill("Old");
    await oldStarted;
    await search.fill("New");
    await page.getByRole("link", { name: "New result", exact: true }).waitFor();
    const oldFinished = page.waitForResponse(
      (response) => new URL(response.url()).searchParams.get("q") === "Old",
    );
    releaseOld();
    await oldFinished;
    await page
      .getByRole("button", { name: "Tạo nhóm mới", exact: true })
      .focus();
    assert.equal(
      await page.getByRole("link", { name: "Old result", exact: true }).count(),
      0,
    );
    await page.unroute("**/api/v1/groups?**");

    await search.fill("Pending");
    await page.getByRole("button", { name: "Xóa từ khóa tìm kiếm" }).click();
    await page.getByText("Chưa có nhóm học tập nào", { exact: true }).waitFor();
    assert.equal(await search.inputValue(), "");
    await search.fill("Match");
    await page
      .getByText("Không tìm thấy nhóm phù hợp", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Tạo nhóm mới", exact: true })
      .click();
    await page
      .getByLabel("Tên nhóm học tập", { exact: true })
      .fill("Unrelated");
    await page.getByRole("button", { name: "Tạo nhóm", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page
      .getByText("Không tìm thấy nhóm phù hợp", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("link", { name: "Unrelated", exact: true }).count(),
      0,
    );
    await fixture.prisma.group.create({
      data: {
        name: "Match group",
        ownerId: user.id,
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    await page.getByRole("button", { name: "Làm mới", exact: true }).click();
    await page
      .getByRole("link", { name: "Match group", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Sửa", exact: true }).click();
    await page
      .getByLabel("Tên nhóm học tập", { exact: true })
      .fill("Renamed group");
    await page
      .getByRole("button", { name: "Lưu thay đổi", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page
      .getByText("Không tìm thấy nhóm phù hợp", { exact: true })
      .waitFor();
  });
});

test("load-more responses from an old search cannot enter the new list", async () => {
  await withGroups(async (page, user) => {
    const group = (name) => ({
      id: randomUUID(),
      name,
      description: null,
      ownerId: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let releaseMore, moreReceived;
    const moreStarted = new Promise((resolve) => {
      moreReceived = resolve;
    });
    const moreResponse = new Promise((resolve) => {
      releaseMore = resolve;
    });
    await page.route("**/api/v1/groups?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (params.has("cursor")) {
        moreReceived();
        await moreResponse;
        return route.fulfill({
          json: { items: [group("Old next page")], nextCursor: null },
        });
      }
      const isNew = params.get("q") === "New";
      await route.fulfill({
        json: {
          items: [group(isNew ? "New first page" : "Old first page")],
          nextCursor: isNew ? null : "next",
        },
      });
    });
    await page.getByRole("button", { name: "Làm mới", exact: true }).click();
    await page
      .getByRole("button", { name: "Tải thêm nhóm", exact: true })
      .click();
    await moreStarted;
    await page.getByRole("textbox", { name: "Tìm kiếm nhóm" }).fill("New");
    await page
      .getByRole("link", { name: "New first page", exact: true })
      .waitFor();
    const moreFinished = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.has("cursor"),
    );
    releaseMore();
    await moreFinished;
    await page
      .getByRole("button", { name: "Tạo nhóm mới", exact: true })
      .focus();
    assert.equal(
      await page
        .getByRole("link", { name: "Old next page", exact: true })
        .count(),
      0,
    );
  });
});

test("create and edit forms show duplicate-name errors beside the name field", async () => {
  await withGroups(async (page, user) => {
    for (const name of ["Nhóm Toán", "Nhóm Văn"]) {
      await fixture.prisma.group.create({ data: { name, ownerId: user.id } });
    }
    await page.getByRole("button", { name: "Làm mới", exact: true }).click();
    await page.getByRole("link", { name: "Nhóm Toán", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Tạo nhóm mới", exact: true })
      .click();
    await page
      .getByLabel("Tên nhóm học tập", { exact: true })
      .fill("  NHÓM  TOÁN  ");
    await page.getByRole("button", { name: "Tạo nhóm", exact: true }).click();
    const message = "Bạn đã có nhóm mang tên này. Vui lòng chọn tên khác.";
    await page.getByText(message, { exact: true }).waitFor();
    assert.equal(
      await page
        .getByLabel("Tên nhóm học tập", { exact: true })
        .getAttribute("aria-invalid"),
      "true",
    );
    await page.getByRole("button", { name: "Hủy bỏ", exact: true }).click();

    await page
      .locator(".group-card")
      .filter({ hasText: "Nhóm Toán" })
      .getByRole("button", { name: "Sửa", exact: true })
      .click();
    await page.getByLabel("Tên nhóm học tập", { exact: true }).fill("nhóm văn");
    await page
      .getByRole("button", { name: "Lưu thay đổi", exact: true })
      .click();
    await page.getByText(message, { exact: true }).waitFor();
    await page.getByLabel("Tên nhóm học tập", { exact: true }).fill("Nhóm Lý");
    await page
      .getByRole("button", { name: "Lưu thay đổi", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Nhóm Lý", exact: true }).waitFor();
    assert.equal(
      await fixture.prisma.group.count({ where: { ownerId: user.id } }),
      2,
    );
  });
});
