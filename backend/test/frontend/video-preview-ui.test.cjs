const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");
const {
  FileStorageService,
} = require("../../dist/modules/files/file-storage.service");
const {
  VideoRenditionCatalog,
} = require("../../dist/modules/files/video-rendition-catalog");

async function clip(page, width, height) {
  return Buffer.from(
    await page.evaluate(
      async ({ width, height }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const draw = canvas.getContext("2d");
        let frame = 0;
        const tick = () => {
          draw.fillStyle = "#172554";
          draw.fillRect(0, 0, width, height);
          draw.fillStyle = "#67e8f9";
          draw.fillRect((frame++ * 5) % width, 40, 60, 60);
          draw.fillStyle = "#fff";
          draw.font = "20px sans-serif";
          draw.fillText("Streamora video", 20, height - 25);
        };
        tick();
        const stream = canvas.captureStream(12);
        const recorder = new MediaRecorder(stream, {
          mimeType: "video/webm;codecs=vp8",
        });
        const chunks = [];
        recorder.ondataavailable = (event) => chunks.push(event.data);
        const stopped = new Promise((resolve) => {
          recorder.onstop = resolve;
        });
        recorder.start();
        const timer = setInterval(tick, 80);
        await new Promise((resolve) => setTimeout(resolve, 2600));
        recorder.stop();
        await stopped;
        clearInterval(timer);
        stream.getTracks().forEach((track) => track.stop());
        return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
      },
      { width, height },
    ),
  );
}
async function settingsMenu(page) {
  const gear = page.getByRole("button", { name: "Cài đặt video", exact: true });
  if ((await gear.getAttribute("aria-expanded")) !== "true") await gear.click();
  const back = page.getByRole("button", {
    name: "Quay lại cài đặt",
    exact: true,
  });
  if (await back.count()) await back.click();
}
async function refreshQualities(page) {
  await settingsMenu(page);
  await page
    .getByRole("menuitem", { name: "Cập nhật chất lượng", exact: true })
    .click();
  await page.waitForFunction(() => {
    const button = document.querySelector(".video-control-row > button");
    return button && !button.disabled;
  });
}
test(
  "video player: custom controls, speed/quality persistence, interrupted streams, expiry refresh and access rights",
  { timeout: 240000 },
  async () => {
    let fixture, browser, sourcePath;
    try {
      fixture = await createFrontendFixture({ localUploads: true });
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(30000);
      await page.goto(fixture.webOrigin + "/login");
      const original = await clip(page, 640, 360),
        low = await clip(page, 320, 180);
      const email = `video-${randomUUID()}@example.test`,
        password = "Video-test-password-123!";
      const registered = await fetch(fixture.apiUrl + "/auth/register", {
        method: "POST",
        headers: {
          Origin: fixture.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, fullName: "Người xem video" }),
      });
      assert.equal(registered.status, 201);
      const user = (await registered.json()).user;
      const owner = await fixture.prisma.user.create({
        data: {
          email: `owner-${randomUUID()}@example.test`,
          fullName: "Owner",
          passwordHash: await require("argon2").hash(password),
        },
      });
      const group = await fixture.prisma.group.create({
        data: { name: "Video preview group", ownerId: owner.id },
      });
      await fixture.prisma.groupMember.create({
        data: { groupId: group.id, userId: user.id, role: "HOST" },
      });
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      const login = page.waitForResponse(
        (r) =>
          r.url().endsWith("/auth/login") && r.request().method() === "POST",
      );
      await page.locator('button[type="submit"]').click();
      const token = (await (await login).json()).accessToken;
      await page.waitForURL("**/workspace");
      await page.goto(`${fixture.webOrigin}/files?groupId=${group.id}`);
      await page
        .locator('.file-uploader input[type="file"]:not([webkitdirectory])')
        .setInputFiles({
          name: "Video.webm",
          mimeType: "video/webm",
          buffer: original,
        });
      await page.getByText("Đã lưu vào thư viện.", { exact: true }).waitFor();
      // Upload needs HOST; playback must also work after demotion to VIEWER.
      await fixture.prisma.groupMember.update({
        where: { userId_groupId: { userId: user.id, groupId: group.id } },
        data: { role: "VIEWER" },
      });
      await page
        .getByRole("button", { name: "Xem trước Video.webm", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.videoWidth === 640,
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "Xem trước video", exact: true })
          .count(),
        1,
      );
      await settingsMenu(page);
      await page.getByRole("menuitem", { name: /^Chất lượng/ }).click();
      assert.deepEqual(
        (
          await page
            .getByRole("menu", { name: "Chất lượng video", exact: true })
            .getByRole("menuitemradio")
            .allTextContents()
        ).map((value) => value.trim()),
        ["Bản gốc"],
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("dialog[open]").count(), 1);
      await page
        .getByRole("button", { name: "Phát video", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelector(".video-preview video")?.currentTime > 0.4,
      );
      await page
        .getByRole("button", { name: "Tạm dừng video", exact: true })
        .click();
      await settingsMenu(page);
      await page.getByRole("menuitem", { name: /^Tốc độ phát/ }).click();
      await page
        .getByRole("menuitemradio", { name: "1.5×", exact: true })
        .click();
      assert.equal(
        await page
          .locator(".video-preview video")
          .evaluate((video) => video.playbackRate),
        1.5,
      );
      const timeline = page.getByRole("slider", {
        name: "Tua video",
        exact: true,
      });
      const box = await timeline.boundingBox();
      await timeline.click({
        position: { x: box.width * 0.4, y: box.height / 2 },
      });
      await page.waitForFunction(
        () => document.querySelector(".video-preview video")?.currentTime > 0.5,
      );
      await page
        .getByRole("button", { name: "Tắt âm thanh", exact: true })
        .click();
      assert.equal(
        await page
          .locator(".video-preview video")
          .evaluate((video) => video.muted),
        true,
      );
      await page
        .getByRole("button", { name: "Bật âm thanh", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Toàn màn hình", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.fullscreenElement?.classList.contains("video-player"),
      );
      await page
        .getByRole("button", { name: "Thoát toàn màn hình", exact: true })
        .click();
      await page.waitForFunction(() => !document.fullscreenElement);
      const file = await fixture.prisma.libraryFile.findFirst({
        where: { groupId: group.id },
      });
      const grant = await fetch(`${fixture.apiUrl}/files/${file.id}/playback`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(grant.status, 200);
      const manifest = await grant.json(),
        url = manifest.sources[0].url;
      const range = await fetch(url, { headers: { Range: "bytes=2-8" } });
      assert.equal(range.status, 206);
      assert.deepEqual(
        Buffer.from(await range.arrayBuffer()),
        original.subarray(2, 9),
      );
      const invalid = await fetch(url, {
        headers: { Range: `bytes=${original.length}-` },
      });
      assert.equal(invalid.status, 416);
      assert.equal(
        invalid.headers.get("content-range"),
        `bytes */${original.length}`,
      );
      const head = await fetch(url, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get("content-length")), original.length);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      const key = `groups/${group.id}/videos/${file.id}/v1/180.webm`;
      sourcePath = join(
        fixture.previewRoot,
        `video-variant-${randomUUID()}.webm`,
      );
      // Exercise clients abandoning a large response before it has been read.
      // Those streams must close explicitly, including before garbage collection.
      const storage = fixture.app.get(FileStorageService);
      const interruptedKey = `range-stress/${randomUUID()}`;
      await writeFile(sourcePath, Buffer.alloc(16 * 1024 ** 2, 42));
      await storage.importLocalFile(sourcePath, interruptedKey);
      const interruptedUrl = (
        await storage.download(interruptedKey, "stress.bin")
      ).url;
      for (let i = 0; i < 6; i++) {
        const interrupted = await fetch(interruptedUrl, {
          headers: { Range: "bytes=0-" },
        });
        assert.equal(interrupted.status, 206);
        await interrupted.body.cancel();
      }
      await page.waitForTimeout(100);
      if (global.gc) global.gc();
      await storage.delete(interruptedKey);
      await writeFile(sourcePath, low);
      await fixture.app
        .get(FileStorageService)
        .importLocalFile(sourcePath, key);
      fixture.app.get(VideoRenditionCatalog).read = async () => ({
        status: "READY",
        progressPercent: null,
        renditions: [
          {
            id: "180p",
            height: 180,
            bitrate: 200000,
            mimeType: "video/webm",
            objectKey: key,
          },
        ],
      });
      await page.locator(".video-preview video").evaluate(async (video) => {
        video.muted = true;
        await video.play();
      });
      await page.waitForFunction(
        () => document.querySelector(".video-preview video")?.currentTime > 0.6,
      );
      await page
        .locator(".video-preview video")
        .evaluate((video) => video.pause());
      await refreshQualities(page);
      await settingsMenu(page);
      await page.getByRole("menuitem", { name: /^Chất lượng/ }).click();
      await page
        .getByRole("menuitemradio", { name: "180p", exact: true })
        .click();
      await page.waitForFunction(() => {
        const video = document.querySelector(".video-preview video");
        return video?.videoWidth === 320 && video.currentTime > 0.5;
      });
      assert.equal(
        await page
          .locator(".video-preview video")
          .evaluate((video) => video.playbackRate),
        1.5,
      );
      const local = fixture.app.get(FileStorageService).local;
      const ttl = local.options.ttlSeconds;
      local.options.ttlSeconds = 1;
      await refreshQualities(page);
      const expiredUrl = await page
        .locator(".video-preview video")
        .getAttribute("src");
      local.options.ttlSeconds = ttl;
      const renewed = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/files/${file.id}/playback`) &&
          r.request().method() === "POST",
      );
      // T13 renews the grant proactively, before the next segment/seek fails.
      assert.equal((await renewed).status(), 200);
      await page.waitForTimeout(1200);
      assert.equal((await fetch(expiredUrl)).status, 403);
      await page.waitForFunction((previous) => {
        const video = document.querySelector(".video-preview video");
        return (
          video?.src !== previous &&
          video.videoWidth === 320 &&
          video.currentTime > 0.5
        );
      }, expiredUrl);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      // The signed grant stays bounded; issuing a new one must consult current membership.
      await fixture.prisma.groupMember.delete({
        where: { userId_groupId: { userId: user.id, groupId: group.id } },
      });
      const denied = await fetch(
        `${fixture.apiUrl}/files/${file.id}/playback`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(denied.status, 403);
    } finally {
      if (browser) await browser.close();
      if (sourcePath) await rm(sourcePath, { force: true });
      if (fixture) await fixture.cleanup();
    }
  },
);
