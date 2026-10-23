const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { chromium } = require("playwright");
const argon2 = require("argon2");
const { createFrontendFixture } = require("./frontend-fixture.cjs");
let fixture, browser, passwordHash;
const password = "Class-session-ui-password-123!";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(work) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await work();
    if (value) return value;
    await pause(80);
  }
  assert.fail("Database condition did not become true");
}
before(
  async () => {
    browser = await chromium.launch({
      headless: true,
      channel:
        process.env.STREAMORA_TEST_BROWSER_CHANNEL ??
        (process.platform === "win32" ? "msedge" : undefined),
    });
    fixture = await createFrontendFixture({
      sessionRealtime: {
        pollIntervalMs: 80,
        sweepIntervalMs: 150,
        heartbeatIntervalMs: 1000,
        leaseTtlMs: 5000,
      },
    });
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
      "Idempotency-Key": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
async function account(name) {
  const email = `t04-ui-${randomUUID()}@example.test`;
  // T04 tests seed real password hashes; browser login still uses the real auth
  // endpoint. Avoid consuming registration/login quotas to prepare API actors.
  passwordHash ??= await argon2.hash(password);
  const user = await fixture.prisma.user.create({
    data: { email, passwordHash, fullName: name },
  });
  const token = await fixture.issueAccessToken(user.id);
  return { id: user.id, email, fullName: user.fullName, token };
}
async function login(page, actor, expected = "**/workspace") {
  await page.getByLabel("Email", { exact: true }).fill(actor.email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.waitForURL(expected);
}
async function contextFor(actor, options = {}) {
  const context = await browser.newContext({
    timezoneId: "Asia/Bangkok",
    ...options,
  });
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${fixture.webOrigin}/login`);
  await login(page, actor);
  return { context, page };
}
async function groupFixture() {
  const owner = await account("Chủ lớp T04"),
    viewer = await account("Học viên T04");
  const { group } = await api(owner, "POST", "/groups", {
    name: `Nhóm T04 ${randomUUID().slice(0, 7)}`,
  });
  await api(owner, "POST", `/groups/${group.id}/members`, {
    userId: viewer.id,
    role: "VIEWER",
  });
  return { owner, viewer, group };
}
async function lesson(owner, group, live = true, title = "Buổi học T04") {
  const { session } = await api(owner, "POST", `/groups/${group.id}/sessions`, {
    title,
    scheduledAt: "2026-10-25T06:30:00Z",
  });
  if (live) await api(owner, "POST", `/sessions/${session.id}/start`, {});
  return session;
}
const openRoom = async (page, session) => {
  await page.goto(`${fixture.webOrigin}/sessions/${session.id}`);
  await page
    .getByRole("heading", { name: session.title, exact: true })
    .waitFor();
};
const queue = (page) =>
  page.getByRole("region", { name: "Hàng chờ duyệt", exact: true });
const people = (page) =>
  page.getByRole("region", { name: "Người trong phòng", exact: true });
async function requestAndAccept(ownerPage, viewerPage, viewer) {
  await viewerPage
    .getByRole("button", { name: "Xin vào phòng", exact: true })
    .click();
  await viewerPage
    .getByText("Đang chờ người quản lý duyệt", { exact: true })
    .waitFor();
  await queue(ownerPage)
    .getByRole("button", { name: `Chấp nhận ${viewer.fullName}`, exact: true })
    .click();
  await viewerPage
    .getByRole("button", { name: "Vào phòng", exact: true })
    .waitFor();
}

test("T04 owner creates/edits local-time schedules through group navigation and starts only on an explicit action", async () => {
  const { owner, group } = await groupFixture(),
    { context, page } = await contextFor(owner);
  try {
    await page.goto(`${fixture.webOrigin}/groups/${group.id}`);
    await page.getByRole("link", { name: "Xem lịch học", exact: true }).click();
    await page
      .getByRole("button", { name: "Lên lịch buổi học", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Tạo lịch học", exact: true })
      .click();
    await page
      .getByText("Nhập tên từ 1 đến 100 ký tự.", { exact: true })
      .waitFor();
    await page
      .getByLabel("Tên buổi học", { exact: true })
      .fill("Lịch thật từ giao diện");
    await page
      .getByLabel("Thời gian dự kiến", { exact: true })
      .fill("2026-10-25T13:45");
    await page
      .getByRole("button", { name: "Tạo lịch học", exact: true })
      .click();
    await page.waitForURL("**/sessions/*");
    const id = new URL(page.url()).pathname.split("/").at(-1);
    const row = await fixture.prisma.classSession.findUnique({ where: { id } });
    assert.equal(row.scheduledAt.toISOString(), "2026-10-25T06:45:00.000Z");
    assert.equal(row.status, "SCHEDULED");
    await page
      .getByRole("button", { name: "Chỉnh sửa lịch", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Thời gian dự kiến", { exact: true }).inputValue(),
      "2026-10-25T13:45",
    );
    await page
      .getByLabel("Tên buổi học", { exact: true })
      .fill("Lịch đã chỉnh sửa");
    await page
      .getByRole("button", { name: "Lưu thay đổi", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Lịch đã chỉnh sửa", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Bắt đầu buổi học", exact: true })
      .click();
    await page.getByText("Đang diễn ra", { exact: true }).waitFor();
    assert.notEqual(
      await page
        .getByRole("button", { name: "Kết thúc buổi học", exact: true })
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    assert.equal(
      await fixture.prisma.classParticipation.count({
        where: { sessionId: id },
      }),
      0,
    );
    await page.getByRole("button", { name: "Vào phòng", exact: true }).click();
    await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
    const visit = await until(() =>
      fixture.prisma.classParticipation.findFirst({
        where: { sessionId: id, userId: owner.id, leftAt: null },
      }),
    );
    await until(
      async () =>
        await fixture.prisma.classPresenceLease.count({
          where: { participationId: visit.id },
        }),
    );
    await pause(5600); // Beyond the test lease TTL: the real browser must heartbeat.
    const current = await fixture.prisma.classParticipation.findUnique({
      where: { id: visit.id },
    });
    assert.equal(current.leftAt, null);
    assert.ok(current.lastSeenAt > new Date(visit.joinedAt.getTime() + 3000));
  } finally {
    await context.close();
  }
});

test("T04 reject/retry/accept remains private, acceptance needs enter, and leaving closes the same visit on every tab", async () => {
  const { owner, viewer, group } = await groupFixture(),
    session = await lesson(owner, group);
  const host = await contextFor(owner),
    guest = await contextFor(viewer);
  try {
    await Promise.all([
      openRoom(host.page, session),
      openRoom(guest.page, session),
    ]);
    assert.equal(await queue(guest.page).count(), 0);
    assert.equal(await people(guest.page).count(), 0);
    const keys = [];
    guest.page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/join-requests")
      )
        keys.push(request.headers()["idempotency-key"]);
    });
    await guest.page
      .getByRole("button", { name: "Xin vào phòng", exact: true })
      .click();
    await queue(host.page)
      .getByRole("button", { name: `Từ chối ${viewer.fullName}`, exact: true })
      .click();
    await guest.page
      .getByText("Yêu cầu đã bị từ chối. Bạn có thể chủ động xin vào lại.", {
        exact: true,
      })
      .waitFor();
    await guest.page
      .getByRole("button", { name: "Xin vào lại", exact: true })
      .click();
    await queue(host.page)
      .getByRole("button", {
        name: `Chấp nhận ${viewer.fullName}`,
        exact: true,
      })
      .click();
    await guest.page
      .getByRole("button", { name: "Vào phòng", exact: true })
      .waitFor();
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(
      await fixture.prisma.classParticipation.count({
        where: { sessionId: session.id },
      }),
      0,
    );
    await guest.page
      .getByRole("button", { name: "Vào phòng", exact: true })
      .click();
    await people(host.page)
      .getByText(viewer.fullName, { exact: true })
      .waitFor();
    await guest.page
      .getByText("Bạn đang ở trong phòng", { exact: true })
      .waitFor();
    await host.page.screenshot({
      path: join(fixture.previewRoot, "t04-session-desktop.png"),
      fullPage: true,
    });
    const another = await guest.context.newPage();
    await openRoom(another, session);
    await another
      .getByText("Bạn đang ở trong phòng", { exact: true })
      .waitFor();
    const visit = await fixture.prisma.classParticipation.findFirst({
      where: { sessionId: session.id, userId: viewer.id, leftAt: null },
    });
    await until(
      async () =>
        (await fixture.prisma.classPresenceLease.count({
          where: { participationId: visit.id },
        })) === 2,
    );
    assert.equal(
      await fixture.prisma.classParticipation.count({
        where: { sessionId: session.id, leftAt: null },
      }),
      1,
    );
    await another
      .getByRole("button", { name: "Rời phòng", exact: true })
      .click();
    await guest.page
      .getByRole("button", { name: "Xin vào lại", exact: true })
      .waitFor();
    assert.equal(
      (
        await fixture.prisma.classParticipation.findUnique({
          where: { id: visit.id },
        })
      ).leaveReason,
      "LEFT",
    );
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test("T04 cancellation removes a pending request from the manager queue", async () => {
  const { owner, viewer, group } = await groupFixture(),
    session = await lesson(owner, group);
  const host = await contextFor(owner),
    guest = await contextFor(viewer);
  try {
    await Promise.all([
      openRoom(host.page, session),
      openRoom(guest.page, session),
    ]);
    await guest.page
      .getByRole("button", { name: "Xin vào phòng", exact: true })
      .click();
    await queue(host.page)
      .getByText(viewer.fullName, { exact: true })
      .waitFor();
    await guest.page
      .getByRole("button", { name: "Hủy yêu cầu", exact: true })
      .click();
    await queue(host.page)
      .getByRole("heading", { name: "Không có yêu cầu đang chờ", exact: true })
      .waitFor();
    assert.equal(
      (
        await fixture.prisma.classJoinRequest.findFirst({
          where: { sessionId: session.id, userId: viewer.id },
        })
      ).status,
      "CANCELLED",
    );
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test("T04 meet creation retries a lost create response and failed start without duplicating the meet", async () => {
  const owner = await account("Chủ meet retry"),
    { context, page } = await contextFor(owner);
  let lost = true,
    failedStart = true;
  const keys = [];
  try {
    await page.route(`${fixture.apiUrl}/meets`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]);
      if (lost) {
        lost = false;
        await route.fetch();
        return route.abort("failed");
      }
      return route.continue();
    });
    await page.route(`${fixture.apiUrl}/sessions/*/start`, (route) => {
      if (failedStart) {
        failedStart = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE" } }),
        });
      }
      return route.continue();
    });
    await page.goto(`${fixture.webOrigin}/meet`);
    await page
      .getByLabel("Tên cuộc họp", { exact: true })
      .fill("Meet không tạo trùng");
    await page
      .getByRole("button", { name: "Tạo và bắt đầu", exact: true })
      .click();
    await page
      .getByText(
        "Không thể kết nối đến máy chủ. Vui lòng kiểm tra kết nối và thử lại.",
        { exact: true },
      )
      .waitFor();
    await page
      .getByRole("button", { name: "Tạo và bắt đầu", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Tiếp tục mở cuộc họp", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Tên cuộc họp", { exact: true }).isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Tiếp tục mở cuộc họp", exact: true })
      .click();
    await page.waitForURL(/\/meet\/[A-Z0-9]{12}$/);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    const rows = await fixture.prisma.classSession.findMany({
      where: { createdById: owner.id, kind: "MEET" },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "LIVE");
    assert.equal(
      await fixture.prisma.classParticipation.count({
        where: { sessionId: rows[0].id },
      }),
      0,
    );
  } finally {
    await context.close();
  }
});

test("T04 independent meet invitations survive login, admit outsiders after approval, and end across pages", async () => {
  const owner = await account("Chủ meet độc lập"),
    viewer = await account("Khách meet độc lập");
  const { session } = await api(owner, "POST", "/meets", {
    title: "Meet theo liên kết",
  });
  await api(owner, "POST", `/sessions/${session.id}/start`, {});
  const host = await contextFor(owner),
    context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    const path = `/meet/${session.joinCode}`;
    await host.page.goto(fixture.webOrigin + path);
    await page.goto(fixture.webOrigin + path);
    await page.waitForURL("**/login?next=*");
    await login(page, viewer, fixture.webOrigin + path);
    await page
      .getByRole("heading", { name: session.title, exact: true })
      .waitFor();
    assert.equal(await queue(page).count(), 0);
    assert.equal(await people(page).count(), 0);
    await requestAndAccept(host.page, page, viewer);
    await page.getByRole("button", { name: "Vào phòng", exact: true }).click();
    await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
    await host.page
      .getByRole("button", { name: "Kết thúc buổi học", exact: true })
      .click();
    await host.page
      .getByRole("button", { name: "Xác nhận kết thúc", exact: true })
      .click();
    await page.getByText("Đã kết thúc", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Vào phòng", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await fixture.prisma.classParticipation.count({
        where: { sessionId: session.id, leftAt: null },
      }),
      0,
    );
  } finally {
    await host.context.close();
    await context.close();
  }
});

test("T04 a downgraded host keeps the visit but immediately loses manager controls and private queue", async () => {
  const { owner, viewer, group } = await groupFixture();
  await api(owner, "PATCH", `/groups/${group.id}/members/${viewer.id}`, {
    role: "HOST",
  });
  const session = await lesson(owner, group),
    { context, page } = await contextFor(viewer);
  try {
    await openRoom(page, session);
    await page.getByRole("button", { name: "Vào phòng", exact: true }).click();
    await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
    await api(owner, "PATCH", `/groups/${group.id}/members/${viewer.id}`, {
      role: "VIEWER",
    });
    await until(async () => (await queue(page).count()) === 0);
    await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "Quản lý buổi học", exact: true })
        .count(),
      0,
    );
    await api(owner, "DELETE", `/groups/${group.id}/members/${viewer.id}`);
    await page
      .getByRole("heading", { name: "Bạn chưa có quyền truy cập", exact: true })
      .waitFor();
    assert.equal(await people(page).count(), 0);
  } finally {
    await context.close();
  }
});

test("T04 loss of all connections expires the visit and online recovery never enters automatically", async () => {
  const { owner, viewer, group } = await groupFixture(),
    session = await lesson(owner, group);
  const request = await api(
    viewer,
    "POST",
    `/sessions/${session.id}/join-requests`,
    {},
  );
  await api(
    owner,
    "PATCH",
    `/sessions/${session.id}/join-requests/${request.request.id}`,
    { decision: "ACCEPT" },
  );
  const { context, page } = await contextFor(viewer);
  try {
    await openRoom(page, session);
    await page.getByRole("button", { name: "Vào phòng", exact: true }).click();
    await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
    const visit = await fixture.prisma.classParticipation.findFirst({
      where: { sessionId: session.id, userId: viewer.id, leftAt: null },
    });
    await until(
      async () =>
        await fixture.prisma.classPresenceLease.count({
          where: { participationId: visit.id },
        }),
    );
    await context.setOffline(true);
    await until(
      async () =>
        (
          await fixture.prisma.classParticipation.findUnique({
            where: { id: visit.id },
          })
        ).leftAt,
    );
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page
      .getByRole("button", { name: "Xin vào lại", exact: true })
      .waitFor();
    assert.equal(
      await fixture.prisma.classParticipation.count({
        where: { sessionId: session.id },
      }),
      1,
    );
    assert.equal(
      (
        await fixture.prisma.classParticipation.findUnique({
          where: { id: visit.id },
        })
      ).leaveReason,
      "DISCONNECTED",
    );
  } finally {
    await context.close();
  }
});

test("T04 schedule pagination, status filters and mobile layouts use real data", async () => {
  const { owner, group } = await groupFixture();
  for (let i = 0; i < 22; i++)
    await lesson(
      owner,
      group,
      false,
      `Lịch phân trang ${String(i + 1).padStart(2, "0")}`,
    );
  const { context, page } = await contextFor(owner, {
    viewport: { width: 390, height: 844 },
  });
  try {
    await page.goto(`${fixture.webOrigin}/groups/${group.id}/sessions`);
    await page
      .getByRole("button", { name: "Xem thêm buổi học", exact: true })
      .waitFor();
    assert.equal(await page.locator(".class-session-card").count(), 20);
    await page
      .getByRole("button", { name: "Xem thêm buổi học", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".class-session-card").length === 22,
    );
    await page.screenshot({
      path: join(fixture.previewRoot, "t04-schedule-mobile.png"),
      fullPage: false,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page
      .getByLabel("Trạng thái", { exact: true })
      .selectOption("CANCELLED");
    await page
      .getByRole("heading", { name: "Chưa có buổi học", exact: true })
      .waitFor();
    await page.goto(`${fixture.webOrigin}/meet`);
    await page
      .getByLabel("Mã hoặc liên kết cuộc họp", { exact: true })
      .fill("https://other.example/meet/ABCDEFGHIJKL");
    await page
      .getByRole("button", { name: "Mở cuộc họp", exact: true })
      .click();
    await page
      .getByText(
        "Nhập mã 12 ký tự hoặc liên kết Meet của Streamora trên trang này.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.locator(".site-header .theme-toggle").click();
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await page.screenshot({
      path: join(fixture.previewRoot, "t04-meet-mobile.png"),
      fullPage: true,
    });
    const { session: meet } = await api(owner, "POST", "/meets", {
      title: "Meet mở bằng mã",
    });
    await page
      .getByLabel("Mã hoặc liên kết cuộc họp", { exact: true })
      .fill(meet.joinCode.toLowerCase());
    await page
      .getByRole("button", { name: "Mở cuộc họp", exact: true })
      .click();
    await page
      .getByRole("heading", { name: meet.title, exact: true })
      .waitFor();
  } finally {
    await context.close();
  }
});

test("T04 cancelled schedules cannot be started, and outsiders cannot open group rooms", async () => {
  const { owner, group } = await groupFixture(),
    outsider = await account("Ngoài nhóm");
  const session = await lesson(owner, group, false),
    host = await contextFor(owner),
    stranger = await contextFor(outsider);
  try {
    await openRoom(host.page, session);
    await host.page
      .getByRole("button", { name: "Hủy buổi học", exact: true })
      .click();
    await host.page
      .getByRole("button", { name: "Xác nhận hủy", exact: true })
      .click();
    await host.page.getByText("Đã hủy", { exact: true }).waitFor();
    assert.equal(
      await host.page
        .getByRole("button", { name: "Bắt đầu buổi học", exact: true })
        .count(),
      0,
    );
    await stranger.page.goto(`${fixture.webOrigin}/sessions/${session.id}`);
    await stranger.page
      .getByRole("heading", { name: "Bạn chưa có quyền truy cập", exact: true })
      .waitFor();
    assert.equal(
      await stranger.page
        .getByRole("heading", { name: session.title, exact: true })
        .count(),
      0,
    );
  } finally {
    await host.context.close();
    await stranger.context.close();
  }
});

test("T04 login refuses external return destinations", async () => {
  const actor = await account("Đăng nhập an toàn"),
    context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(
      `${fixture.webOrigin}/login?next=${encodeURIComponent("https://other.example/meet/ABCDEFGHIJKL")}`,
    );
    await login(page, actor);
    assert.equal(new URL(page.url()).origin, fixture.webOrigin);
  } finally {
    await context.close();
  }
});

test("T04 manager queue paginates beyond the first page", async () => {
  const { owner, group } = await groupFixture(),
    session = await lesson(owner, group);
  const users = Array.from({ length: 21 }, (_, index) => ({
    id: randomUUID(),
    email: `queue-${randomUUID()}@example.test`,
    fullName: `Người chờ ${String(index + 1).padStart(2, "0")}`,
    passwordHash: "$argon2id$non-loginable-ui-fixture",
  }));
  await fixture.prisma.user.createMany({ data: users });
  await fixture.prisma.classJoinRequest.createMany({
    data: users.map((user) => ({ sessionId: session.id, userId: user.id })),
  });
  const { context, page } = await contextFor(owner);
  try {
    let reads = 0;
    page.on("requestfinished", (request) => {
      if (request.url().endsWith(`/sessions/${session.id}/admission`)) reads++;
    });
    await openRoom(page, session);
    await until(() => reads >= 2);
    await queue(page)
      .getByRole("button", { name: "Xem thêm yêu cầu", exact: true })
      .waitFor();
    assert.equal(await queue(page).locator(".class-people > li").count(), 20);
    await queue(page)
      .getByRole("button", { name: "Xem thêm yêu cầu", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[aria-labelledby="class-queue-title"] .class-people > li',
        ).length === 21,
    );
  } finally {
    await context.close();
  }
});

test("T04 logout in another tab clears the protected room and preserves its destination for login", async () => {
  const { owner, viewer, group } = await groupFixture(),
    session = await lesson(owner, group);
  const { context, page } = await contextFor(viewer);
  try {
    await openRoom(page, session);
    const accountPage = await context.newPage();
    await accountPage.goto(`${fixture.webOrigin}/account`);
    await accountPage
      .getByRole("button", { name: "Đăng xuất", exact: true })
      .click();
    await page.waitForURL("**/login?next=*");
    assert.equal(
      await page
        .getByRole("heading", { name: session.title, exact: true })
        .count(),
      0,
    );
    assert.equal(
      new URL(page.url()).searchParams.get("next"),
      `/sessions/${session.id}`,
    );
  } finally {
    await context.close();
  }
});
