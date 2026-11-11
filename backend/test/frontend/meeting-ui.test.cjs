const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { cp, mkdir, writeFile, rm } = require("node:fs/promises");
const { resolve, join, dirname } = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { createServer } = require("node:net");
const { chromium } = require("playwright");
const { createMeetingFixture } = require("../meeting-fixture.cjs");

test(
  "Workspace room channels stay in the same shell, isolate groups, leave previous visits and synchronize creation/end",
  { timeout: 240000 },
  async () => {
    const root = resolve(__dirname, "../../..");
    const directory = join(root, ".preview", `meeting-ui-${randomUUID()}`);
    const screenshots = join(root, ".preview", "meeting-review");
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    let f, browser, server;
    try {
      f = await createMeetingFixture(origin);
      const owner = await f.account("Minh · Chủ lớp"),
        member = await f.account("An · Học viên"),
        guest = await f.account("Khách mời");
      const password = "Meeting-browser-password-123!";
      const hash = await require("argon2").hash(password);
      await f.prisma.user.updateMany({ data: { passwordHash: hash } });
      const group = async (name) =>
        f.prisma.group.create({
          data: {
            name,
            ownerId: owner.id,
            members: {
              create: [
                { userId: owner.id, role: "OWNER" },
                { userId: member.id, role: "VIEWER" },
              ],
            },
          },
        });
      const a = await group("Hệ thống phân tán"),
        b = await group("Thiết kế phần mềm"),
        empty = await group("Lớp chưa có cuộc họp");
      const create = async (groupId, body) => {
        const result = await f.api(
          owner,
          "POST",
          groupId ? `/groups/${groupId}/sessions` : "/meets",
          body,
          randomUUID(),
        );
        assert.equal(result.status, 201, JSON.stringify(result.body));
        return result.body.session;
      };
      const privateRoom = await create(a.id, { title: "Ôn tập giữa kỳ" });
      const publicRoom = await create(a.id, {
        title: "Trao đổi cùng khách mời",
        allowGuests: true,
      });
      const otherRoom = await create(b.id, { title: "Review đồ án" });
      const standalone = await create(null, { title: "Cuộc hẹn độc lập" });
      await f.prisma.classSession.createMany({
        data: Array.from({ length: 21 }, (_, i) => ({
          groupId: b.id,
          kind: "GROUP",
          createdById: owner.id,
          title: `Phòng ôn tập ${i + 1}`,
          joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
          scheduledAt: new Date(),
        })),
      });
      await f.api(
        owner,
        "POST",
        `/sessions/${publicRoom.id}/start`,
        {},
        randomUUID(),
      );
      await mkdir(directory, { recursive: true });
      await mkdir(screenshots, { recursive: true });
      for (const name of ["src", "public"])
        await cp(join(root, "frontend", name), join(directory, name), {
          recursive: true,
        });
      for (const name of ["tsconfig.json", "package.json", "next-env.d.ts"])
        await cp(join(root, "frontend", name), join(directory, name));
      await writeFile(
        join(directory, "next.config.ts"),
        'import config from "../../frontend/next.config"; export default { ...config, experimental: { cpus: 1 } };',
      );
      const env = {
        ...process.env,
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: f.base,
        NEXT_TELEMETRY_DISABLED: "1",
      };
      const next = require.resolve("next/dist/bin/next");
      await promisify(execFile)(process.execPath, [next, "build"], {
        cwd: directory,
        env,
        timeout: 150000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      console.log("Isolated production build passed");
      server = spawn(
        process.execPath,
        [next, "start", "--hostname", "127.0.0.1", "--port", String(port)],
        { cwd: directory, env, stdio: "ignore", windowsHide: true },
      );
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(origin)).ok) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
        ],
      });
      const errors = [];
      const login = async (actor) => {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        });
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/login`);
        await page.getByLabel("Email", { exact: true }).fill(actor.email);
        await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL("**/workspace");
        return page;
      };
      const page = await login(owner);
      const viewer = await login(member);
      const channels = (p) =>
        p.getByRole("navigation", { name: "Phòng họp của lớp" });
      const roomButton = (p, title) =>
        channels(p).getByRole("button").filter({ hasText: title });
      const heading = (p, title) =>
        p.getByRole("heading", { name: title, exact: true });
      const selectGroup = (p, group) =>
        p
          .getByRole("button", { name: `Mở nhóm ${group.name}`, exact: true })
          .click();
      const waitForClosed = async (sessionId) => {
        for (let i = 0; i < 60; i++) {
          if (
            !(await f.prisma.classParticipation.count({
              where: { sessionId, userId: owner.id, leftAt: null },
            }))
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        assert.fail("Previous meeting participation must be closed");
      };
      await page.goto(`${origin}/workspace?groupId=${a.id}`);
      await viewer.goto(`${origin}/workspace?groupId=${a.id}`);
      await roomButton(page, privateRoom.title).waitFor();
      await roomButton(viewer, privateRoom.title).waitFor();
      assert.equal(
        await page.getByRole("tablist", { name: "Lớp học" }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("link", { name: "Meeting", exact: true }).count(),
        0,
      );
      assert.equal(await page.locator(".meetings-hub").count(), 0);
      assert.equal(
        await viewer
          .getByRole("button", { name: "Tạo cuộc họp", exact: true })
          .count(),
        0,
      );
      await page.evaluate(() => {
        window.__meetingShell = document.querySelector(".app-shell");
        window.__meetingDocument = "persistent-workspace";
      });
      await page.screenshot({
        path: join(screenshots, "workspace-meetings.png"),
        fullPage: true,
        animations: "disabled",
      });
      await page
        .getByRole("button", { name: "Tạo cuộc họp", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Tạo cuộc họp",
        exact: true,
      });
      await dialog.getByText(a.name, { exact: true }).waitFor();
      assert.equal(await dialog.getByRole("combobox").count(), 0);
      assert.equal(await dialog.getByRole("tablist").count(), 0);
      await dialog.getByLabel("Cho phép người ngoài Group tham gia").check();
      await page.screenshot({
        path: join(screenshots, "create-meeting.png"),
        fullPage: true,
        animations: "disabled",
      });
      await dialog
        .getByRole("button", { name: "Tạo cuộc họp", exact: true })
        .click();
      await heading(page, "Cuộc họp 3").waitFor();
      await roomButton(viewer, "Cuộc họp 3").waitFor({ timeout: 8000 });
      assert.equal(new URL(page.url()).pathname, "/workspace");
      assert.equal(page.context().pages().length, 1);
      assert.equal(
        await page.evaluate(
          () =>
            window.__meetingShell === document.querySelector(".app-shell") &&
            window.__meetingDocument === "persistent-workspace",
        ),
        true,
      );
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      const createdId = new URL(page.url()).searchParams.get("meetingId");
      assert.equal(
        await f.prisma.groupChatMessage.count({
          where: { groupId: a.id, meeting: { title: "Cuộc họp 3" } },
        }),
        1,
      );
      await page.screenshot({
        path: join(screenshots, "workspace-room.png"),
        fullPage: true,
        animations: "disabled",
      });
      const rightPanel = page.locator(".right-panel");
      await rightPanel.getByRole("log", { name: "Lịch sử tin nhắn" }).waitFor();
      await rightPanel
        .getByLabel("Tin nhắn", { exact: true })
        .fill("Cả lớp cùng thảo luận trong cuộc họp.");
      await rightPanel
        .getByRole("button", { name: "Gửi tin nhắn", exact: true })
        .click();
      await viewer
        .getByText("Cả lớp cùng thảo luận trong cuộc họp.", { exact: true })
        .waitFor({ timeout: 8000 });
      await page
        .getByRole("button", { name: "Người tham gia", exact: true })
        .click();
      await rightPanel
        .getByRole("region", { name: "Người trong phòng", exact: true })
        .getByText(owner.fullName, { exact: true })
        .waitFor();
      await rightPanel.getByRole("button", { name: /^Trò chuyện/ }).click();
      await page.getByRole("button", { name: "Liên kết", exact: true }).click();
      const info = page.getByRole("dialog", {
        name: "Thông tin cuộc họp",
        exact: true,
      });
      const createdRoom = await f.prisma.classSession.findUnique({
        where: { id: createdId },
      });
      assert.equal(
        await info.getByLabel("Liên kết tham gia").inputValue(),
        `${origin}/meet/${createdRoom.joinCode}`,
      );
      await info
        .getByRole("button", { name: "Đóng thông tin cuộc họp", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Quản lý phòng", exact: true })
        .click();
      const management = page.getByRole("dialog", {
        name: "Quản lý cuộc họp",
        exact: true,
      });
      await management
        .getByRole("button", { name: "Kết thúc buổi học", exact: true })
        .waitFor();
      await management
        .getByRole("button", { name: "Đóng thông tin cuộc họp", exact: true })
        .click();
      const geometry = await page.evaluate(() => {
        const stage = document
          .querySelector(".workspace-media-stage")
          .getBoundingClientRect();
        const controls = document
          .querySelector(".workspace-call-controls")
          .getBoundingClientRect();
        return {
          stageHeight: stage.height,
          stageBottom: stage.bottom,
          controlsTop: controls.top,
          controlsBottom: controls.bottom,
          viewport: innerHeight,
          horizontal: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.ok(geometry.stageHeight > 500, JSON.stringify(geometry));
      assert.ok(
        geometry.controlsTop >= geometry.stageBottom,
        JSON.stringify(geometry),
      );
      assert.ok(
        geometry.controlsBottom <= geometry.viewport && !geometry.horizontal,
        JSON.stringify(geometry),
      );
      await page
        .getByRole("button", { name: "Chế độ tối", exact: true })
        .click();
      await page.screenshot({
        path: join(screenshots, "workspace-room-dark.png"),
        fullPage: true,
        animations: "disabled",
      });
      const leaveBounds = await page
        .getByRole("button", { name: "Rời phòng", exact: true })
        .boundingBox();
      assert.ok(leaveBounds.x > 950, JSON.stringify(leaveBounds));
      await page.setViewportSize({ width: 1920, height: 916 });
      await page.screenshot({
        path: join(screenshots, "workspace-room-reference-size.png"),
        fullPage: true,
        animations: "disabled",
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      const media = page.getByRole("region", { name: "Mic và camera" });
      await media
        .getByRole("button", { name: "Kiểm tra thiết bị", exact: true })
        .click();
      await media.locator("video").waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".class-media-room video")
            ?.srcObject?.getTracks().length > 0,
      );
      const tracks = await media
        .locator("video")
        .evaluateHandle((video) => video.srcObject.getTracks());
      await page.screenshot({
        path: join(screenshots, "workspace-room-video-dark.png"),
        fullPage: true,
        animations: "disabled",
      });
      await roomButton(page, publicRoom.title).click();
      await heading(page, publicRoom.title).waitFor();
      await waitForClosed(createdId);
      assert.equal(
        await tracks.evaluate((items) =>
          items.every((track) => track.readyState === "ended"),
        ),
        true,
      );
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      await page.goBack();
      await heading(page, "Cuộc họp 3").waitFor();
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      await waitForClosed(publicRoom.id);
      await page.goForward();
      await heading(page, publicRoom.title).waitFor();
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      const leaveRoute = `**/sessions/${publicRoom.id}/participations/*/leave`;
      await page.route(leaveRoute, (route) => route.abort());
      await roomButton(page, "Cuộc họp 3").click();
      await page
        .getByText(
          "Chưa thể rời phòng hiện tại. Kiểm tra kết nối rồi thử lại.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        new URL(page.url()).searchParams.get("meetingId"),
        publicRoom.id,
      );
      assert.equal(await heading(page, publicRoom.title).count(), 1);
      await page.unroute(leaveRoute);
      await page
        .locator(".app-toast.error")
        .getByRole("button", { name: "Đóng thông báo", exact: true })
        .click();
      await selectGroup(page, b);
      await roomButton(page, otherRoom.title).waitFor();
      assert.equal(await channels(page).getByRole("button").count(), 22);
      assert.equal(await roomButton(page, privateRoom.title).count(), 0);
      await waitForClosed(publicRoom.id);
      assert.equal(
        await page.evaluate(
          () => window.__meetingShell === document.querySelector(".app-shell"),
        ),
        true,
      );
      await selectGroup(page, empty);
      await page.waitForFunction(
        (id) => new URLSearchParams(location.search).get("groupId") === id,
        empty.id,
      );
      assert.equal(await channels(page).getByRole("button").count(), 0);
      assert.equal(
        await page
          .getByRole("button", { name: "Meeting", exact: true })
          .count(),
        0,
      );
      await selectGroup(page, a);
      await roomButton(page, "Cuộc họp 3").click();
      await heading(page, "Cuộc họp 3").waitFor();
      await viewer
        .getByRole("link", { name: "thông-báo", exact: false })
        .first()
        .click();
      const announcement = viewer
        .locator(".message")
        .filter({ hasText: "Đã tạo cuộc họp: Cuộc họp 3" });
      await announcement.waitFor();
      await viewer.evaluate(() => {
        window.__announcementShell = document.querySelector(".app-shell");
      });
      await announcement
        .getByRole("link", { name: "Tham gia cuộc họp →", exact: true })
        .click();
      await heading(viewer, "Cuộc họp 3").waitFor();
      assert.equal(
        await viewer.evaluate(
          () =>
            window.__announcementShell === document.querySelector(".app-shell"),
        ),
        true,
      );
      assert.equal(
        (
          await f.api(
            owner,
            "POST",
            `/sessions/${createdId}/end`,
            {},
            randomUUID(),
          )
        ).status,
        200,
      );
      await roomButton(viewer, "Cuộc họp 3").waitFor({
        state: "detached",
        timeout: 8000,
      });
      await roomButton(page, "Cuộc họp 3").waitFor({
        state: "detached",
        timeout: 8000,
      });
      await page.locator(".meeting-room .class-status.ended").waitFor();
      const renamed = "Trao đổi cùng chuyên gia";
      assert.equal(
        (
          await f.api(owner, "PATCH", `/sessions/${publicRoom.id}`, {
            title: renamed,
          })
        ).status,
        200,
      );
      await roomButton(viewer, renamed).waitFor({ timeout: 8000 });
      await roomButton(page, renamed).waitFor({ timeout: 8000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await selectGroup(page, a);
      await roomButton(page, renamed).click();
      await heading(page, renamed).waitFor();
      await page
        .getByRole("region", { name: "Mic và camera", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Rời phòng", exact: true })
        .waitFor();
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      await page.screenshot({
        path: join(screenshots, "workspace-room-mobile.png"),
        fullPage: true,
        animations: "disabled",
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await viewer.goto(`${origin}/meet/${publicRoom.joinCode}`);
      await viewer.waitForURL(
        `**/workspace?groupId=${a.id}&meetingId=${publicRoom.id}`,
      );
      await viewer
        .getByText("Bạn đang ở trong phòng", { exact: true })
        .waitFor();
      const outsider = await login(guest);
      await outsider.goto(`${origin}/meet/${privateRoom.joinCode}`);
      await outsider
        .getByRole("heading", {
          name: "Không thể tham gia cuộc họp",
          exact: true,
        })
        .waitFor();
      assert.equal(await outsider.locator(".app-shell").count(), 0);
      assert.equal(
        (
          await f.api(
            owner,
            "POST",
            `/sessions/${privateRoom.id}/cancel`,
            {},
            randomUUID(),
          )
        ).status,
        200,
      );
      await roomButton(viewer, privateRoom.title).waitFor({
        state: "detached",
        timeout: 8000,
      });
      await outsider.goto(`${origin}/meet/${publicRoom.joinCode}`);
      await outsider
        .getByRole("heading", { name: renamed, exact: true })
        .waitFor();
      assert.equal(await outsider.locator(".app-shell").count(), 0);
      await outsider
        .getByRole("button", { name: "Xin vào phòng", exact: true })
        .click();
      await outsider
        .getByText("Đang chờ người quản lý duyệt", { exact: true })
        .waitFor();
      await outsider.screenshot({
        path: join(screenshots, "standalone-room.png"),
        fullPage: true,
        animations: "disabled",
      });
      await outsider.setViewportSize({ width: 390, height: 844 });
      await outsider.screenshot({
        path: join(screenshots, "standalone-room-mobile.png"),
        fullPage: true,
        animations: "disabled",
      });
      assert.ok(
        await outsider.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await viewer.goto(`${origin}/meet/${standalone.joinCode}`);
      await viewer
        .getByRole("heading", { name: standalone.title, exact: true })
        .waitFor();
      assert.equal(await viewer.locator(".app-shell").count(), 0);
      assert.deepEqual(errors, []);
      const mediaEnv = { ...env, STREAMORA_TEST_WEB_ROOT: directory };
      delete mediaEnv.NODE_TEST_CONTEXT;
      const mediaCheck = await promisify(execFile)(
        process.execPath,
        ["--test", join(__dirname, "class-media-ui.test.cjs")],
        {
          cwd: root,
          env: mediaEnv,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );
      assert.match(mediaCheck.stdout, /pass 1/);
      console.log(mediaCheck.stdout);
      console.log(
        "Meeting routing, creation, membership, guest admission, desktop/mobile and browser errors passed",
      );
    } finally {
      if (browser) await browser.close();
      if (server) {
        server.kill();
        await new Promise((resolve) => server.once("exit", resolve));
      }
      if (f) await f.cleanup();
      assert.equal(dirname(directory), join(root, ".preview"));
      assert.match(directory, /meeting-ui-[a-f0-9-]{36}$/);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
