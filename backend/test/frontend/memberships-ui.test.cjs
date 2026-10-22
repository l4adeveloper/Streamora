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
  await page.waitForURL("**/workspace");
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
        document
          .querySelector('.workspace-groups [aria-current="true"]')
          ?.getAttribute("aria-label") === expected,
      `Mở nhóm ${group.name}`,
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
      .getByRole("button", {
        name: `Mở nhóm ${other.body.group.name}`,
        exact: true,
      })
      .click();
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

test("workspace rail lists accessible groups and switches actual permissions, with a single account footer", async () => {
  const { owner, viewer, group } = await seed();
  const second = (
    await api(viewer, "POST", "/groups", {
      name: `Nhóm đọc sách ${randomUUID().slice(0, 6)}`,
    })
  ).body.group;
  await api(viewer, "POST", `/groups/${second.id}/members`, {
    userId: owner.id,
    role: "VIEWER",
  });
  const unjoined = (
    await api(viewer, "POST", "/groups", {
      name: `Nhóm chưa tham gia ${randomUUID().slice(0, 6)}`,
    })
  ).body.group;
  const { context, page } = await contextFor(owner);
  try {
    await page.goto(`${fixture.webOrigin}/workspace?groupId=${group.id}`);
    const firstButton = page.getByRole("button", {
      name: `Mở nhóm ${group.name}`,
      exact: true,
    });
    const secondButton = page.getByRole("button", {
      name: `Mở nhóm ${second.name}`,
      exact: true,
    });
    await firstButton.waitFor();
    assert.equal(
      await page
        .locator('.workspace-groups button[aria-label^="Mở nhóm "]')
        .count(),
      2,
    );
    assert.equal(
      await page
        .getByRole("button", { name: `Mở nhóm ${unjoined.name}`, exact: true })
        .count(),
      0,
    );
    assert.equal(await firstButton.getAttribute("aria-current"), "true");
    await page.waitForFunction(
      () => document.querySelectorAll(".workspace-account").length === 1,
    );
    assert.equal(await page.locator(".workspace-account").count(), 1);
    assert.equal(
      await page.locator(".workspace-account b").textContent(),
      owner.fullName,
    );
    assert.equal(
      await page.locator(".workspace-account").getAttribute("href"),
      "/account",
    );
    assert.equal(
      await page
        .locator(
          ".community-rail .profile-avatar, .workspace-group-picker, .invite-card",
        )
        .count(),
      0,
    );
    assert.equal(
      await page.locator('.channel-sidebar a[href="/groups"]').count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("link", { name: "Thêm nhóm học tập", exact: true })
        .getAttribute("href"),
      "/groups",
    );

    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.textContent.trim() === "Ghi hình" && !button.disabled,
      ),
    );
    await secondButton.click();
    await page.waitForURL(`**/workspace?groupId=${second.id}`);
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".community-title b")?.textContent === expected,
      second.name,
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "Ghi hình" && button.disabled,
      ),
    );
    assert.equal(await secondButton.getAttribute("aria-current"), "true");
    assert.equal(await firstButton.getAttribute("aria-current"), null);

    await page.reload();
    await secondButton.waitFor();
    assert.equal(await secondButton.getAttribute("aria-current"), "true");
    await page.goto(`${fixture.webOrigin}/files`);
    await secondButton.waitFor();
    assert.equal(await secondButton.getAttribute("aria-current"), "true");
    await page
      .getByRole("button", { name: "Thành viên", exact: true })
      .first()
      .click();
    await page.getByText(viewer.email, { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Email thành viên mới", { exact: true }).count(),
      0,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await firstButton.click();
    await page.locator(".app-shell.nav-open").waitFor();
    await page.getByLabel("Email thành viên mới", { exact: true }).waitFor();
    assert.equal(
      await page.getByText(viewer.email, { exact: true }).count(),
      0,
    );
    assert.equal(await page.locator(".workspace-account").isVisible(), true);
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      ),
      false,
    );
    await page.screenshot({
      path: join(fixture.previewRoot, "workspace-groups-mobile.png"),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.screenshot({
      path: join(fixture.previewRoot, "workspace-groups-desktop.png"),
    });
  } finally {
    await context.close();
  }
});

test("overview members can navigate to every workspace section and adding members stays in the overview", async () => {
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
  await fixture.prisma.user.update({
    where: { id: owner.id },
    data: { globalRole: "ADMIN" },
  });
  const { context, page } = await contextFor(owner);
  const shell = page.locator(".app-shell:visible");
  const overview = () =>
    shell
      .locator(".channel-sidebar")
      .getByRole("button", { name: "Thành viên", exact: true });
  try {
    await page.goto(
      `${fixture.webOrigin}/workspace?groupId=${group.id}&tab=members`,
    );
    await shell.locator(".membership-main .membership-add").waitFor();
    assert.equal(
      await shell.locator('.breadcrumbs [aria-current="page"]').textContent(),
      "Thành viên",
    );
    assert.equal(
      await shell.locator(".sidebar-scroll .channel.selected").count(),
      1,
    );

    for (const [href, section] of [
      ["/workspace", "Lớp học trực tiếp"],
      ["/community", "trò chuyện chung"],
      ["/files", "Tài liệu chung"],
      ["/files?type=recordings", "Bản ghi bài giảng"],
      ["/meet", "Tạo cuộc họp"],
      ["/rooms/nhom-01", "Phòng học nhóm"],
    ]) {
      await shell.locator(`.channel-sidebar a.channel[href="${href}"]`).click();
      await page.waitForURL(`${fixture.webOrigin}${href}`);
      await page.waitForFunction(
        (expected) =>
          [
            ...document.querySelectorAll(
              '.app-shell .breadcrumbs [aria-current="page"]',
            ),
          ].some((element) => element.textContent === expected),
        section,
      );
      await shell.locator("main:not(.membership-main)").waitFor();
      await shell
        .locator(".breadcrumbs > span")
        .filter({ hasText: group.name })
        .waitFor();
      assert.equal(
        await shell.locator(".breadcrumbs > span").textContent(),
        group.name,
      );
      assert.equal(
        await shell.locator('.breadcrumbs [aria-current="page"]').textContent(),
        section,
      );
      assert.equal(
        await shell.locator(".sidebar-scroll .channel.selected").count(),
        1,
      );
      assert.equal(
        await shell
          .locator(".sidebar-scroll .channel.selected")
          .getAttribute("href"),
        href,
      );
      await overview().click();
      await shell.locator(".membership-main .membership-add").waitFor();
      assert.equal(
        await shell.locator('.breadcrumbs [aria-current="page"]').textContent(),
        "Thành viên",
      );
    }

    await shell.locator('.channel-sidebar a[href="/community"]').click();
    await shell.locator(".community-chat").waitFor();
    const topbar = shell.locator(".workspace-topbar");
    assert.equal((await topbar.boundingBox()).height, 60);
    assert.equal(await shell.locator(".workspace-heading").count(), 0);
    assert.equal(await topbar.locator(".connection, .avatar").count(), 0);
    await topbar
      .getByRole("button", { name: "Mời tham gia", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Đóng", exact: true })
      .click();
    const sidebarMembers = shell.locator(".right-panel");
    if (!(await sidebarMembers.isVisible())) {
      await shell
        .getByRole("button", {
          name: "Mở trò chuyện và thành viên",
          exact: true,
        })
        .click();
    }
    await sidebarMembers
      .getByRole("button", { name: "Thành viên", exact: true })
      .click();
    await sidebarMembers.locator(".membership-person b").first().waitFor();
    assert.equal(await sidebarMembers.locator(".membership-add").count(), 0);
    await sidebarMembers.getByText(viewer.email, { exact: true }).waitFor();
    assert.equal(
      await sidebarMembers
        .locator(".membership-controls, .membership-remove, select")
        .count(),
      0,
    );
    assert.equal(
      await sidebarMembers
        .getByLabel("Email thành viên mới", { exact: true })
        .count(),
      0,
    );
    await sidebarMembers
      .getByLabel("Tìm thành viên theo tên hoặc email", { exact: true })
      .fill(viewer.email);
    await sidebarMembers.getByText(viewer.email, { exact: true }).waitFor();
    await page.screenshot({
      path: join(fixture.previewRoot, "workspace-chat-members.png"),
    });

    await overview().click();
    await shell.getByLabel("Email thành viên mới", { exact: true }).waitFor();
    assert.equal(await shell.locator(".membership-add").count(), 1);
    await shell
      .getByLabel(`Vai trò của ${viewer.fullName}`, { exact: true })
      .waitFor();
    assert.equal(
      await shell
        .getByLabel(`Xóa ${viewer.fullName} khỏi nhóm`, { exact: true })
        .isVisible(),
      true,
    );
  } finally {
    await context.close();
  }
});

test("chat history scrolls independently while composing and sending stays fixed on desktop and mobile", async () => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1366, height: 768 },
  });
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.abort(),
  );
  await context.addInitScript(() => {
    localStorage.setItem(
      "streamora-chat:trò-chuyện-chung",
      JSON.stringify(
        Array.from({ length: 60 }, (_, index) => ({
          name: "Thành viên thử nghiệm",
          initials: "TV",
          color: "blue",
          time: "10:00",
          text: `Tin nhắn lịch sử ${index + 1}`,
        })),
      ),
    );
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await page.goto(`${fixture.webOrigin}/community`);
    const shell = page.locator(".app-shell:visible");
    const history = shell.locator(".community-chat .chat-history");
    const composer = shell.locator(".community-chat .chat-form");
    await history.getByText("Tin nhắn lịch sử 60", { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const element = document.querySelector(".community-chat .chat-history");
      return element && element.scrollTop > 0;
    });
    const before = await composer.boundingBox();
    assert.ok(before);
    assert.equal(
      await history.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
      true,
    );
    await history.evaluate((element) => {
      element.scrollTop = 0;
    });
    assert.equal(await history.evaluate((element) => element.scrollTop), 0);
    const after = await composer.boundingBox();
    assert.ok(after);
    assert.ok(Math.abs(before.y - after.y) < 1);
    assert.equal(
      await composer.evaluate((element) => element.closest(".chat-history")),
      null,
    );
    await composer
      .getByRole("textbox", { name: "Tin nhắn", exact: true })
      .fill("Tin nhắn mới từ khung cố định");
    await composer
      .getByRole("button", { name: "Gửi tin nhắn", exact: true })
      .click();
    await history
      .getByText("Tin nhắn mới từ khung cố định", { exact: true })
      .waitFor();
    await page.waitForFunction(() => {
      const element = document.querySelector(".community-chat .chat-history");
      return (
        element.scrollHeight - element.clientHeight - element.scrollTop < 2
      );
    });
    assert.equal(
      await composer
        .getByRole("textbox", { name: "Tin nhắn", exact: true })
        .inputValue(),
      "",
    );
    await page.screenshot({
      path: join(fixture.previewRoot, "workspace-chat-fixed-desktop.png"),
    });

    await shell
      .locator(".right-panel")
      .getByRole("button", { name: "Đóng bảng bên", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 600 });
    const mobileTopbar = await shell.locator(".workspace-topbar").boundingBox();
    assert.equal(mobileTopbar.height, 60);
    const mobileInvite = await shell
      .locator(".workspace-topbar")
      .getByRole("button", { name: "Mời tham gia", exact: true })
      .boundingBox();
    assert.ok(mobileInvite && mobileInvite.x + mobileInvite.width <= 390);
    await shell
      .locator(".workspace-topbar")
      .getByRole("button", { name: "Mở trò chuyện và thành viên", exact: true })
      .click();
    assert.equal(
      (await shell.locator(".right-panel").boundingBox()).y,
      mobileTopbar.y + mobileTopbar.height,
    );
    await shell
      .locator(".right-panel")
      .getByRole("button", { name: "Đóng bảng bên", exact: true })
      .click();
    const mobileBefore = await composer.boundingBox();
    await history.evaluate((element) => {
      element.scrollTop = 0;
    });
    const mobileAfter = await composer.boundingBox();
    assert.ok(mobileBefore && mobileAfter);
    assert.ok(Math.abs(mobileBefore.y - mobileAfter.y) < 1);
    assert.ok(mobileAfter.y + mobileAfter.height <= 600);
    assert.equal(
      await shell
        .locator("main")
        .evaluate((element) => element.scrollHeight > element.clientHeight + 1),
      false,
    );
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight > innerHeight + 1 ||
          document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: join(fixture.previewRoot, "workspace-chat-fixed-mobile.png"),
    });
  } finally {
    await context.close();
  }
});

test("native dropdown keyboard selection works and Escape closes the picker before its dialog", async () => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1366, height: 768 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.webOrigin}/workspace`);
    const speed = page.getByRole("combobox", {
      name: "Tốc độ phát",
      exact: true,
    });
    const customizable = await page.evaluate(() =>
      CSS.supports("appearance", "base-select"),
    );
    if (customizable) {
      await speed.focus();
      await page.keyboard.press("Space");
      await page.locator("select:open").waitFor();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    } else {
      await speed.selectOption("1.25");
    }
    assert.equal(await speed.inputValue(), "1.25");
    await page.getByRole("button", { name: "Cài đặt", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const fps = dialog.getByRole("combobox", {
      name: "Tốc độ khung hình khi chia sẻ màn hình",
      exact: true,
    });
    if (customizable) {
      await fps.click();
      await page.locator("select:open").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await page.locator("select:open").count(), 0);
    }
    await fps.selectOption("60");
    await dialog
      .getByRole("button", { name: "Lưu thiết lập", exact: true })
      .click();
    await page.getByRole("button", { name: "Cài đặt", exact: true }).click();
    assert.equal(await fps.inputValue(), "60");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await context.close();
  }
});

test("dark mode supports keyboard toggling, reloads, navigation, tab sync and narrow headers", async () => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1366, height: 768 },
  });
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.abort(),
  );
  const page = await context.newPage();
  const hydrationErrors = [];
  page.on("console", (message) => {
    if (/hydration|hydrated|server rendered HTML/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  const toggle = (target) =>
    target.getByRole("button", { name: "Chế độ tối", exact: true });
  try {
    await page.goto(`${fixture.webOrigin}/`);
    await toggle(page).waitFor();
    assert.equal(await toggle(page).getAttribute("aria-pressed"), "false");
    await toggle(page).focus();
    await toggle(page).press("Space");
    assert.equal(await toggle(page).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(
      await page
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(27, 27, 31)",
    );
    await page.goto(`${fixture.webOrigin}/workspace`);
    await page.waitForURL(`${fixture.webOrigin}/workspace`);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(
      await page
        .locator(".channel-sidebar")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(32, 33, 36)",
    );

    await page
      .locator(".workspace-topbar")
      .getByRole("button", { name: "Mời tham gia", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    assert.notEqual(
      await page
        .getByRole("dialog")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(255, 255, 255)",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Đóng", exact: true })
      .click();
    await page.reload();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".theme-toggle")
          ?.getAttribute("aria-pressed") === "true",
    );
    await page.locator('.channel-sidebar a[href="/files"]').click();
    await page.waitForURL(`${fixture.webOrigin}/files`);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");

    const otherPage = await context.newPage();
    await otherPage.goto(`${fixture.webOrigin}/`);
    await otherPage.waitForFunction(
      () =>
        document
          .querySelector(".theme-toggle")
          ?.getAttribute("aria-pressed") === "true",
    );
    await toggle(otherPage).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".theme-toggle")
          ?.getAttribute("aria-pressed") === "false",
    );
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    await toggle(page).click();
    await page.locator('.channel-sidebar a[href="/community"]').click();
    await page.waitForURL(`${fixture.webOrigin}/community`);
    await page.screenshot({
      path: join(fixture.previewRoot, "workspace-dark-desktop.png"),
    });

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 600 });
      const bounds = await toggle(page).boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth > innerWidth ||
            document.documentElement.scrollHeight > innerHeight,
        ),
        false,
      );
      assert.equal(
        (await page.locator(".workspace-topbar").boundingBox()).height,
        60,
      );
    }
    await page.screenshot({
      path: join(fixture.previewRoot, "workspace-dark-mobile.png"),
    });
    await page.goto(`${fixture.webOrigin}/`);
    const homeToggle = await toggle(page).boundingBox();
    assert.ok(homeToggle && homeToggle.x + homeToggle.width <= 320);
    assert.equal(await toggle(page).getAttribute("aria-pressed"), "true");
    await page.goto(`${fixture.webOrigin}/login`);
    await page.locator(".site-header .theme-toggle").waitFor();
    await toggle(page).click();
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    assert.deepEqual(hydrationErrors, []);
  } finally {
    await context.close();
  }
});
