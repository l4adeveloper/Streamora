const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { stat, rm, readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const {
  VideoDelivery,
} = require("../../dist/modules/video-processing/video-delivery");
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
  { timeout: 300000 },
  async () => {
    let fixture, browser, path, publicServer, releaseMaster;
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
      const segments = /\/video-media\/.*\.ts(?:\?|$)/;
      const downloadedSegments = new Set();
      page.on("response", (response) => {
        if (segments.test(response.url()) && response.ok())
          downloadedSegments.add(response.url());
      });
      // Published qualities must be visible even before the HLS playlist loads.
      const masterPattern = /\/video-media\/.*\/hls\/master\.m3u8(?:\?|$)/;
      const masterGate = new Promise((resolve) => (releaseMaster = resolve));
      await page.route(masterPattern, async (route) => {
        await masterGate;
        await route.continue().catch(() => {}); // The page may close during failed-test cleanup.
      });
      await page
        .getByRole("button", { name: "Xem trước HLS real.mp4", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Cài đặt video", exact: true })
        .click();
      await page.getByRole("menuitem", { name: /^Chất lượng/ }).click();
      await page
        .getByRole("menuitemradio", { name: "480p", exact: true })
        .waitFor();
      assert.deepEqual(
        await page.getByRole("menuitemradio").allTextContents(),
        ["Bản gốc", "Tự động", "1080p", "720p", "480p", "360p"],
      );
      releaseMaster();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.querySelector(".video-preview video")?.readyState >= 2,
      );
      await page.unroute(masterPattern);
      await quality(page, "Bản gốc");
      await page.waitForFunction(
        () => document.querySelector(".video-preview video")?.readyState >= 2,
      );
      await quality(page, "480p");
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.videoHeight === 480,
      );
      // Lock quality so returning to a buffered range cannot trigger an ABR upgrade.
      await quality(page, "360p");
      await page.waitForFunction(() => {
        const v = document.querySelector(".video-preview video");
        return (
          v.videoHeight === 360 &&
          Array.from(
            { length: v.buffered.length },
            (_, i) => v.buffered.start(i) <= 10 && v.buffered.end(i) > 12,
          ).some(Boolean)
        );
      });
      // A cold seek must keep its requested position visible while the segment loads.
      await page.route(segments, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route.continue();
      });
      const timeline = page.getByRole("slider", {
        name: "Tua video",
        exact: true,
      });
      const timelineBox = await timeline.boundingBox();
      await page.locator(".video-preview video").evaluate((v) => {
        v.requestVideoFrameCallback((_now, frame) => {
          window.seekFrame = frame.mediaTime;
        });
      });
      await timeline.click({
        position: { x: timelineBox.width * 0.73, y: timelineBox.height / 2 },
      });
      const seeking = await timeline.evaluate((slider) => {
        const video = document.querySelector(".video-preview video");
        return {
          shown: Number(slider.value),
          actual: video.currentTime,
          seeking: video.seeking,
        };
      });
      assert.ok(
        seeking.actual > 64 && seeking.actual < 68,
        JSON.stringify(seeking),
      );
      assert.ok(
        Math.abs(seeking.shown - seeking.actual) < 0.1,
        JSON.stringify(seeking),
      );
      await page.waitForFunction(
        () => {
          const v = document.querySelector(".video-preview video");
          return (
            !v.seeking &&
            v.readyState >= 2 &&
            v.currentTime > 64 &&
            window.seekFrame > 64
          );
        },
        null,
        { timeout: 5000 },
      );
      await page.unrouteAll({ behavior: "wait" });
      await page.waitForFunction(() => {
        const v = document.querySelector(".video-preview video");
        return Array.from({ length: v.buffered.length }, (_, i) =>
          v.buffered.end(i),
        ).some((end) => end > 89);
      });
      const retained = await page
        .locator(".video-preview video")
        .evaluate((v) =>
          Array.from({ length: v.buffered.length }, (_, i) => [
            v.buffered.start(i),
            v.buffered.end(i),
          ]),
        );
      assert.ok(
        retained.some(([start, end]) => start <= 10 && end > 12),
        `Earlier buffer was discarded: ${JSON.stringify(retained)}`,
      );
      const mediaSource = await page
        .locator(".video-preview video")
        .evaluate((v) => v.src);
      const repeatedSegments = [];
      await page.route(segments, async (route) => {
        if (downloadedSegments.has(route.request().url())) {
          repeatedSegments.push(route.request().url());
          await route.abort();
        } else await route.continue();
      });
      // Refuse repeated downloads: both disjoint ranges must still render from MSE.
      const timelineDuration = Number(await timeline.getAttribute("max"));
      for (const target of [10, 66, 10, 66]) {
        await timeline.click({
          position: {
            x: 6 + ((timelineBox.width - 12) * target) / timelineDuration,
            y: timelineBox.height / 2,
          },
        });
        await page.waitForFunction(
          (target) => {
            const v = document.querySelector(".video-preview video");
            return (
              !v.seeking &&
              v.readyState >= 2 &&
              v.paused &&
              Math.abs(v.currentTime - target) < 0.2
            );
          },
          target,
          { timeout: 3000 },
        );
      }
      assert.equal(
        await page.locator(".video-preview video").evaluate((v) => v.src),
        mediaSource,
      );
      assert.deepEqual(
        repeatedSegments,
        [],
        "A buffered segment was requested again",
      );
      const bufferPaint = await timeline.evaluate((slider) =>
        slider.style.getPropertyValue("--buffered-ranges"),
      );
      assert.ok(
        (bufferPaint.match(/#ffffff88/g) ?? []).length >= 4,
        "Timeline must show both buffered islands",
      );
      await page.unrouteAll({ behavior: "wait" });
      // Arrow shortcuts must work after clicking play/pause and the timeline.
      const playButton = page.getByRole("button", {
        name: "Phát video",
        exact: true,
      });
      await playButton.focus();
      const beforeArrow = await page
        .locator(".video-preview video")
        .evaluate((v) => v.currentTime);
      await page.keyboard.press("ArrowLeft");
      assert.ok(
        Math.abs(
          (await page
            .locator(".video-preview video")
            .evaluate((v) => v.currentTime)) -
            (beforeArrow - 5),
        ) < 0.1,
      );
      await timeline.focus();
      await page.keyboard.press("ArrowRight");
      assert.ok(
        Math.abs(
          (await page
            .locator(".video-preview video")
            .evaluate((v) => v.currentTime)) - beforeArrow,
        ) < 0.1,
      );
      // Rapid clicks use the latest destination; dragging keeps a preview without
      // issuing intermediate seeks and still commits when released outside the bar.
      for (const fraction of [0.2, 0.85, 0.48]) {
        await timeline.click({
          position: {
            x: timelineBox.width * fraction,
            y: timelineBox.height / 2,
          },
        });
      }
      await page.waitForFunction(() => {
        const v = document.querySelector(".video-preview video");
        return (
          !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 43.2) < 1
        );
      });
      const dragStart = await page
        .locator(".video-preview video")
        .evaluate((v) => v.currentTime);
      await page.mouse.move(
        timelineBox.x + timelineBox.width * 0.48,
        timelineBox.y + timelineBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        timelineBox.x + timelineBox.width * 0.25,
        timelineBox.y + timelineBox.height + 25,
        { steps: 5 },
      );
      assert.equal(
        await page
          .locator(".video-preview video")
          .evaluate((v) => v.currentTime),
        dragStart,
      );
      await page.mouse.up();
      await page.waitForFunction(() => {
        const v = document.querySelector(".video-preview video");
        return (
          !v.seeking &&
          v.readyState >= 2 &&
          Math.abs(v.currentTime - 22.5) < 1 &&
          v.paused
        );
      });
      // Native volume keys remain volume controls, and menu navigation never seeks.
      const volume = page.getByRole("slider", {
        name: "Âm lượng",
        exact: true,
      });
      await volume.focus();
      const beforeVolume = await page
        .locator(".video-preview video")
        .evaluate((v) => v.currentTime);
      await page.keyboard.press("ArrowLeft");
      assert.equal(
        await page
          .locator(".video-preview video")
          .evaluate((v) => v.currentTime),
        beforeVolume,
      );
      await page
        .getByRole("button", { name: "Cài đặt video", exact: true })
        .click();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page
          .locator(".video-preview video")
          .evaluate((v) => v.currentTime),
        beforeVolume,
      );
      await page.keyboard.press("Escape");
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
        .getByRole("button", { name: "Toàn màn hình", exact: true })
        .click();
      await page.waitForFunction(() => !!document.fullscreenElement);
      await page
        .getByRole("button", { name: "Bản chép lời", exact: true })
        .click();
      await page.waitForFunction(() => {
        const panel = document.querySelector(".recording-transcript");
        const bounds = panel?.getBoundingClientRect();
        const player = document
          .querySelector(".video-player")
          .getBoundingClientRect();
        return (
          document.fullscreenElement?.contains(panel) &&
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.right <= window.innerWidth &&
          bounds.bottom <= window.innerHeight &&
          player.right <= bounds.left
        );
      });
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
      assert.equal(await page.locator(".recording-transcript").count(), 0);
      assert.equal(
        await page.evaluate(() => !!document.fullscreenElement),
        true,
      );
      await page
        .getByRole("button", { name: "Bản chép lời", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Thoát toàn màn hình", exact: true })
        .click();
      await page.waitForFunction(() => !document.fullscreenElement);
      assert.equal(
        await page.locator(".recording-transcript").isVisible(),
        true,
      );
      // Entering fullscreen with the panel already open must retain it too.
      await page
        .getByRole("button", { name: "Toàn màn hình", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.fullscreenElement?.contains(
          document.querySelector(".recording-transcript"),
        ),
      );
      await page
        .getByRole("button", { name: "Bản chép lời", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Thoát toàn màn hình", exact: true })
        .click();
      await page.waitForFunction(() => !document.fullscreenElement);
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
      const processingRequest = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/files/${file.id}/processing`) &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("menuitem", { name: "Cập nhật chất lượng", exact: true })
        .click();
      assert.equal((await processingRequest).status(), 202);
      const rebuilt = await fixture.prisma.videoAsset.findUniqueOrThrow({
        where: { fileId: file.id },
      });
      assert.notEqual(rebuilt.currentJobId, jobId);
      assert.equal(rebuilt.publishedJobId, jobId);
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
      // Model public CloudFront: wildcard CORS rejects credentialed requests.
      const publicRequests = [];
      let corsEnabled = true;
      publicServer = createServer(async (request, response) => {
        try {
          const key = decodeURIComponent(
            new URL(request.url, "http://localhost").pathname.slice(1),
          );
          if (
            !key.startsWith(job.output.prefix + "/") ||
            key
              .split("/")
              .some(
                (part) => part === ".." || part === "." || part.includes("\\"),
              )
          )
            throw new Error("invalid path");
          publicRequests.push({ key, cookie: request.headers.cookie });
          if (corsEnabled)
            response.setHeader("Access-Control-Allow-Origin", "*");
          response.setHeader(
            "Content-Type",
            key.endsWith(".m3u8")
              ? "application/vnd.apple.mpegurl"
              : key.endsWith(".jpg")
                ? "image/jpeg"
                : "video/mp2t",
          );
          response.end(
            await readFile(join(storage.local.options.directory, key)),
          );
        } catch {
          response.writeHead(404);
          response.end();
        }
      });
      await new Promise((resolve) =>
        publicServer.listen(0, "127.0.0.1", resolve),
      );
      const publicBase = "http://127.0.0.1:" + publicServer.address().port;
      fixture.app.get(VideoDelivery).grant = async (_file, _job, output) => ({
        url: publicBase + "/" + output.masterKey,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        public: true,
        cookies: [],
        assetUrl: (key) => publicBase + "/" + key,
      });
      await page.reload();
      await page
        .getByRole("button", { name: "Xem trước HLS real.mp4", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelector(".video-preview video")?.readyState >= 2,
      );
      await quality(page, "360p");
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.videoHeight === 360,
      );
      assert.equal(
        await page.locator(".video-preview video").getAttribute("crossorigin"),
        "anonymous",
      );
      assert.ok(publicRequests.some((request) => request.key.endsWith(".ts")));
      assert.ok(
        publicRequests.every((request) => !request.cookie),
        "public HLS must not send cookies",
      );
      // Model the production failure: HTTP 200 without CORS is blocked by Chrome.
      corsEnabled = false;
      await page.reload();
      await page
        .getByRole("button", { name: "Xem trước HLS real.mp4", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "CORS" })
        .waitFor({ timeout: 45000 });
      await page
        .getByRole("button", { name: "Cài đặt video", exact: true })
        .click();
      await page.getByRole("menuitem", { name: /^Chất lượng/ }).click();
      assert.equal(
        await page
          .getByRole("menuitemradio", { name: "480p", exact: true })
          .count(),
        1,
      );
      await page.keyboard.press("Escape");
      corsEnabled = true;
      await page
        .getByRole("button", { name: "Thử lại video", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelector(".video-preview video")?.readyState >= 2,
      );
      await quality(page, "480p");
      await page.waitForFunction(
        () =>
          document.querySelector(".video-preview video")?.videoHeight === 480,
      );
      await page.getByRole("button", { name: "Đóng", exact: true }).click();
      assert.equal(await page.locator(".video-preview video").count(), 0);
    } finally {
      releaseMaster?.();
      await browser?.close();
      if (publicServer)
        await new Promise((resolve) => publicServer.close(resolve));
      await fixture?.cleanup();
      if (path) await rm(path, { force: true });
    }
  },
);
