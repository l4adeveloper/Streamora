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
  "Meeting links select the authorized shell, group tabs isolate rooms, and creation announces a meeting",
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
        b = await group("Thiết kế phần mềm");
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
      await page.goto(`${origin}/workspace/meetings?groupId=${a.id}`);
      await page.getByRole("tab", { name: a.name }).waitFor();
      await page
        .getByRole("heading", { name: privateRoom.title, exact: true })
        .waitFor();
      await page.getByRole("tab", { name: b.name }).click();
      await page
        .getByRole("heading", { name: otherRoom.title, exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("heading", { name: privateRoom.title, exact: true })
          .count(),
        0,
      );
      await page.getByRole("tab", { name: a.name }).click();
      await page
        .getByRole("heading", { name: privateRoom.title, exact: true })
        .waitFor();
      await page.screenshot({
        path: join(screenshots, "workspace-meetings.png"),
        fullPage: true,
      });
      await page
        .locator(".main-content")
        .getByRole("button", { name: "Tạo cuộc họp", exact: true })
        .click();
      await page.getByLabel("Cho phép người ngoài Group tham gia").check();
      await page.screenshot({
        path: join(screenshots, "create-meeting.png"),
        fullPage: true,
      });
      await page
        .locator("form")
        .filter({ has: page.getByLabel("Tên cuộc họp", { exact: true }) })
        .getByRole("button", { name: "Tạo cuộc họp", exact: true })
        .click();
      await page.waitForURL("**/workspace/meetings/*?groupId=*");
      await page
        .getByRole("heading", { name: "Cuộc họp 3", exact: true })
        .waitFor();
      assert.equal(await page.locator(".app-shell").count(), 1);
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      assert.equal(
        await f.prisma.groupChatMessage.count({
          where: { groupId: a.id, meeting: { title: "Cuộc họp 3" } },
        }),
        1,
      );
      await page.screenshot({
        path: join(screenshots, "workspace-room.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(screenshots, "workspace-room-mobile.png"),
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      const viewer = await login(member);
      await viewer.goto(`${origin}/meet/${publicRoom.joinCode}`);
      await viewer.waitForURL(
        `**/workspace/meetings/${publicRoom.id}?groupId=${a.id}`,
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
      await outsider.goto(`${origin}/meet/${publicRoom.joinCode}`);
      await outsider
        .getByRole("heading", { name: publicRoom.title, exact: true })
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
      });
      await outsider.setViewportSize({ width: 390, height: 844 });
      await outsider.screenshot({
        path: join(screenshots, "standalone-room-mobile.png"),
        fullPage: true,
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
