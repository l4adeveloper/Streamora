const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { stat, rm } = require("node:fs/promises");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");
const {
  VideoProcessingService,
  enqueueVideo,
} = require("../../dist/modules/video-processing/video-processing.service");
const {
  VideoWorker,
} = require("../../dist/modules/video-processing/video-worker");
const {
  FileStorageService,
} = require("../../dist/modules/files/file-storage.service");
const {
  runProcess,
} = require("../../dist/modules/video-processing/video-probe");
process.env.TEST_DATABASE_MODE = "embedded";
async function quality(page, name) {
  const gear = page.getByRole("button", { name: "Cài đặt video", exact: true });
  if ((await gear.getAttribute("aria-expanded")) !== "true") await gear.click();
  const back = page.getByRole("button", {
    name: "Quay lại cài đặt",
    exact: true,
  });
  if (await back.count()) await back.click();
  await page.getByRole("menuitem", { name: /^Chất lượng/ }).click();
  await page
    .getByRole("menuitemradio", { name, exact: typeof name === "string" })
    .click();
}
test(
  "real HLS player preserves captions, transcript seeking and playback settings across quality changes and grant refresh",
  { timeout: 240000 },
  async () => {
    let fixture, browser, path;
    try {
      fixture = await createFrontendFixture({ localUploads: true });
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(30000);
      const email = `hls-${randomUUID()}@example.test`,
        password = "Video-HLS-test-123!";
      const registered = await fetch(fixture.apiUrl + "/auth/register", {
        method: "POST",
        headers: {
          Origin: fixture.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, fullName: "HLS viewer" }),
      });
      assert.equal(registered.status, 201);
      const user = (await registered.json()).user;
      const group = await fixture.prisma.group.create({
        data: { name: "HLS fixture", ownerId: user.id },
      });
      const service = fixture.app.get(VideoProcessingService),
        storage = fixture.app.get(FileStorageService);
      service.config.video.ffmpegPath =
        require("@ffmpeg-installer/ffmpeg").path;
      service.config.video.ffprobePath =
        require("@ffprobe-installer/ffprobe").path;
      service.config.video.scratchDirectory = join(
        storage.locations.target.directory,
        "scratch",
      );
      path = join(fixture.previewRoot, `hls-fixture-${randomUUID()}.mp4`);
      await runProcess(
        service.config.video.ffmpegPath,
        [
          "-nostdin",
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=1920x1080:r=6:d=90",
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-threads",
          "2",
          path,
        ],
        { timeout: 90000 },
      );
      const key = `groups/${group.id}/uploads/${randomUUID()}`,
        location = await storage.currentLocationId();
      await storage.importLocalFile(path, key, location);
      const file = await fixture.prisma.libraryFile.create({
        data: {
          groupId: group.id,
          createdBy: user.id,
          name: "HLS real.mp4",
          mimeType: "video/mp4",
          size: BigInt((await stat(path)).size),
          source: "DOCUMENT",
          status: "AVAILABLE",
          objectKey: key,
          storageLocationId: location,
        },
      });
      const jobId = await fixture.prisma.$transaction((tx) =>
        enqueueVideo(tx, file, "ffmpeg"),
      );
      await fixture.app.get(VideoWorker).once(jobId);
      const job = await fixture.prisma.videoJob.findUnique({
        where: { id: jobId },
      });
      assert.equal(job.state, "READY", job.errorCode);
      await fixture.prisma.videoTranscript.create({
        data: {
          fileId: file.id,
          transcriptStatus: "READY",
          transcriptCues: [
            { startMs: 10000, endMs: 20000, text: "First caption" },
            { startMs: 30000, endMs: 45000, text: "Caption after seeking" },
          ],
        },
      });
      await page.goto(fixture.webOrigin + "/login");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(`${fixture.webOrigin}/files?groupId=${group.id}`);
      await page
        .getByRole("button", { name: "Xem trước HLS real.mp4", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelector(".video-preview video")?.readyState >= 2,
      );
      await page
        .getByRole("button", { name: "Phụ đề (CC)", exact: true })
        .click();
      async function captionsShowing() {
        await page.waitForFunction(() => {
          const tracks = document.querySelector(
            ".video-preview video",
          )?.textTracks;
          return (
            tracks &&
            Array.from(tracks).some(
              (track) => track.mode === "showing" && track.cues?.length === 2,
            )
          );
        });
      }
      await captionsShowing();
      await page
        .getByRole("button", { name: "Bản chép lời", exact: true })
        .click();
      await page
        .locator(".recording-transcript button")
        .filter({ hasText: "Caption after seeking" })
        .click();
      await page.waitForFunction(() => {
        const video = document.querySelector(".video-preview video");
        return video && Math.abs(video.currentTime - 30) < 1;
      });
      assert.equal(
        await page
          .locator(".recording-transcript button[aria-current='true']")
          .textContent(),
        "0:30Caption after seeking",
      );
      await page
        .getByRole("button", { name: "Bản chép lời", exact: true })
        .click();
      await page.locator(".video-preview video").evaluate((v) => {
        v.pause();
        v.currentTime = 30;
        v.playbackRate = 1.5;
        v.volume = 0.4;
      });
      await quality(page, "1080p");
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.videoHeight === 1080,
      );
      await quality(page, "360p");
      try {
        await page.waitForFunction(
          () =>
            document.querySelector(".video-preview video")?.videoHeight === 360,
        );
      } catch (error) {
        console.log(
          await page.locator(".video-preview").evaluate((el) => {
            const v = el.querySelector("video");
            return {
              text: el.textContent,
              time: v.currentTime,
              height: v.videoHeight,
              width: v.videoWidth,
              paused: v.paused,
              ready: v.readyState,
              error: v.error?.code,
              buffered: Array.from({ length: v.buffered.length }, (_, i) => [
                v.buffered.start(i),
                v.buffered.end(i),
              ]),
            };
          }),
        );
        throw error;
      }
      const before = await page
        .locator(".video-preview video")
        .evaluate((v) => ({
          time: v.currentTime,
          paused: v.paused,
          rate: v.playbackRate,
          volume: v.volume,
        }));
      assert.ok(Math.abs(before.time - 30) <= 1);
      assert.equal(before.paused, true);
      assert.equal(before.rate, 1.5);
      assert.ok(Math.abs(before.volume - 0.4) < 0.01);
      await captionsShowing();
      await page
        .getByRole("button", { name: "Cài đặt video", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Cập nhật chất lượng", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.videoHeight === 360,
      );
      await captionsShowing();
      await quality(page, /^Tự động/);
      await page
        .getByRole("button", { name: "Phát video", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.currentTime > 30.5,
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.videoHeight === 1080,
      );
      const network = await page.context().newCDPSession(page);
      await network.send("Network.enable");
      await network.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 50,
        downloadThroughput: 80000,
        uploadThroughput: 80000,
      });
      // Seek beyond the fast-network buffer while retaining Auto. The engine must adapt.
      await page.locator(".video-preview video").evaluate((v) => {
        v.currentTime = 75;
      });
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.videoHeight === 360,
        null,
        { timeout: 45000 },
      );
      await network.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await page
        .getByRole("button", { name: "Tạm dừng video", exact: true })
        .click();
      const after = await page
        .locator(".video-preview video")
        .evaluate((v) => ({ rate: v.playbackRate, volume: v.volume }));
      assert.equal(after.rate, 1.5);
      assert.ok(Math.abs(after.volume - 0.4) < 0.01);
      await page.getByRole("button", { name: "Đóng", exact: true }).click();
      assert.equal(await page.locator(".video-preview video").count(), 0);
    } finally {
      await browser?.close();
      await fixture?.cleanup();
      if (path) await rm(path, { force: true });
    }
  },
);
