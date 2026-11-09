const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");

test(
  "T17 browser: immediate pause, reload and resume without reselecting the file, missing parts only",
  { timeout: 240000 },
  async () => {
    let fixture, browser, page, releasePartGate;
    try {
      fixture = await createFrontendFixture({ localUploads: true });
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      page = await browser.newPage();
      page.setDefaultTimeout(45000);
      const email = `t17-${randomUUID()}@example.test`,
        password = "Resume-test-password-123!";
      const registered = await fetch(`${fixture.apiUrl}/auth/register`, {
        method: "POST",
        headers: {
          Origin: fixture.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, fullName: "Resume tester" }),
      });
      assert.equal(registered.status, 201);
      const user = (await registered.json()).user;
      const group = await fixture.prisma.group.create({
        data: { name: "T17", ownerId: user.id },
      });
      await page.goto(`${fixture.webOrigin}/login`);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(`${fixture.webOrigin}/files?groupId=${group.id}`);
      let interrupted = true,
        resumed = false,
        holdResumedParts = false;
      const partGate = new Promise((resolve) => {
        releasePartGate = resolve;
      });
      const resumedParts = [];
      await page.route("**/parts?token=*", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        const token = new URL(route.request().url()).searchParams.get("token");
        const { partNumber } = JSON.parse(
          Buffer.from(token.split(".")[0], "base64url").toString(),
        );
        if (resumed) resumedParts.push(partNumber);
        if (holdResumedParts) await partGate;
        if (interrupted && partNumber > 5) {
          while (
            (
              await storage.list(
                activeUpload.objectKey,
                activeUpload.storageId,
                activeUpload.storageLocationId,
              )
            ).length < 5
          )
            await new Promise((resolve) => setTimeout(resolve, 10));
          await page.evaluate(() => {
            window.batchBlocked = true;
          });
          return route.abort("internetdisconnected");
        }
        return route.continue().catch(() => {});
      });
      const bytes = Buffer.alloc(48 * 1024 ** 2 + 33, 17);
      const file = {
        name: "resume.pdf",
        mimeType: "application/pdf",
        buffer: bytes,
      };
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 5,
        downloadThroughput: 100 * 1024 ** 2,
        uploadThroughput: 2 * 1024 ** 2,
      });
      await page
        .locator('.file-uploader input[type="file"]')
        .setInputFiles(file);
      await page.waitForFunction(
        () =>
          Number(
            document
              .querySelector(".upload-popover progress")
              ?.getAttribute("value"),
          ) > 0,
      );
      const activeUpload = await fixture.prisma.uploadSession.findFirst({
        where: { userId: user.id },
      });
      const storage = fixture.app.get(
        require("../../dist/modules/uploads/multipart-storage.service")
          .MultipartStorageService,
      );
      assert.equal(
        (
          await storage.list(
            activeUpload.objectKey,
            activeUpload.storageId,
            activeUpload.storageLocationId,
          )
        ).length,
        0,
        "Click pause before the first part is saved",
      );
      await page
        .getByRole("button", {
          name: "Tạm dừng tải lên resume.pdf",
          exact: true,
        })
        .click();
      await page
        .getByText("Đã tạm dừng.", { exact: false })
        .waitFor({ timeout: 1000 });
      const before = await fixture.prisma.uploadSession.findFirst({
        where: { userId: user.id },
      });
      assert.ok(before);
      const progressBeforeResume = await page
        .locator(".upload-popover progress")
        .getAttribute("value");
      assert.ok(Number(progressBeforeResume) > 0);
      await page.waitForTimeout(1200); // With throttling still enabled, pause must freeze immediately.
      assert.equal(
        await page.locator(".upload-popover progress").getAttribute("value"),
        progressBeforeResume,
      );
      assert.equal(
        (
          await storage.list(
            before.objectKey,
            before.storageId,
            before.storageLocationId,
          )
        ).length,
        0,
      );
      await page.evaluate(() => {
        window.observedProgress = [];
        const element = document.querySelector(".upload-popover progress");
        window.progressObserver = new MutationObserver(() =>
          window.observedProgress.push(Number(element.getAttribute("value"))),
        );
        window.progressObserver.observe(element, {
          attributes: true,
          attributeFilter: ["value"],
        });
      });
      holdResumedParts = true;
      const statusPath = `**/uploads/${before.id}`;
      await page.route(statusPath, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.continue();
      });
      const resumedStatus = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/uploads/${before.id}`) &&
          response.request().method() === "GET",
      );
      await page
        .getByRole("button", {
          name: "Tiếp tục tải lên resume.pdf",
          exact: true,
        })
        .click();
      await page
        .getByText("Đang đối chiếu các phần đã tải…", { exact: true })
        .waitFor();
      assert.equal(
        await page.locator(".upload-popover progress").getAttribute("value"),
        progressBeforeResume,
      );
      assert.equal((await resumedStatus).status(), 200);
      await page
        .getByText("Đang gửi lại phần bị ngắt…", { exact: true })
        .waitFor();
      assert.equal(
        await page.locator(".upload-popover progress").getAttribute("value"),
        progressBeforeResume,
      );
      holdResumedParts = false;
      releasePartGate();
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await page.waitForFunction(() => window.batchBlocked);
      await page
        .getByRole("button", {
          name: "Tạm dừng tải lên resume.pdf",
          exact: true,
        })
        .click();
      await page
        .getByText("Đã tạm dừng.", { exact: false })
        .waitFor({ timeout: 1000 });
      assert.ok(
        Number(
          await page.locator(".upload-popover progress").getAttribute("value"),
        ) >= 83,
      );
      assert.ok(
        (await page.evaluate(() => window.observedProgress)).every(
          (percent) => percent >= Number(progressBeforeResume),
        ),
      );
      assert.equal(
        (
          await storage.list(
            before.objectKey,
            before.storageId,
            before.storageLocationId,
          )
        ).length,
        5,
      );
      await page.unroute(statusPath);
      await page.reload();
      await page
        .getByRole("button", {
          name: "Tiếp tục tải lên resume.pdf",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.getByLabel("Chọn lại resume.pdf", { exact: true }).count(),
        0,
      );
      assert.equal(
        await fixture.prisma.uploadSession.count({
          where: { userId: user.id },
        }),
        1,
      );
      interrupted = false;
      resumed = true;
      await page
        .getByRole("button", {
          name: "Tiếp tục tải lên resume.pdf",
          exact: true,
        })
        .click();
      await page
        .getByText("Đã lưu vào thư viện.", { exact: true })
        .waitFor({ timeout: 90000 });
      assert.ok(resumedParts.length > 0);
      assert.ok(
        resumedParts.every((number) => number > 5),
        `Unexpected reupload: ${resumedParts}`,
      );
      const session = await fixture.prisma.uploadSession.findUnique({
        where: { id: before.id },
      });
      assert.equal(session.status, "COMPLETED");
      assert.equal(
        await fixture.prisma.uploadSession.count({
          where: { userId: user.id },
        }),
        1,
      );
      const downloadEvent = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Tải xuống resume.pdf", exact: true })
        .click();
      const download = await downloadEvent;
      const stream = await download.createReadStream();
      const hash = createHash("sha256");
      for await (const chunk of stream) hash.update(chunk);
      assert.equal(
        hash.digest("hex"),
        createHash("sha256").update(bytes).digest("hex"),
      );
      const closePrevious = page.getByRole("button", {
        name: "Đóng trạng thái resume.pdf",
        exact: true,
      });
      if (await closePrevious.count()) await closePrevious.click();
      // Exercise the native-handle picker path as well as the input/Blob fallback above.
      await page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        const handle = await dir.getFileHandle("persistent.pdf", {
          create: true,
        });
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array(16 * 1024 ** 2 + 17).fill(28));
        await writer.close();
        window.showOpenFilePicker = async () => [handle];
      });
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 5,
        downloadThroughput: 100 * 1024 ** 2,
        uploadThroughput: 2 * 1024 ** 2,
      });
      await page
        .getByRole("button", { name: "Chọn file tải lên", exact: true })
        .click();
      const handleJob = page
        .locator(".upload-job")
        .filter({ hasText: "persistent.pdf" });
      await page.waitForFunction(() => {
        const row = [...document.querySelectorAll(".upload-job")].find((el) =>
          el.textContent.includes("persistent.pdf"),
        );
        return (
          Number(row?.querySelector("progress")?.getAttribute("value")) > 0
        );
      });
      await handleJob
        .getByRole("button", {
          name: "Tạm dừng tải lên persistent.pdf",
          exact: true,
        })
        .click();
      await handleJob
        .getByText("Đã tạm dừng.", { exact: false })
        .waitFor({ timeout: 1000 });
      await page.reload();
      await page
        .getByRole("button", {
          name: "Tiếp tục tải lên persistent.pdf",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByLabel("Chọn lại persistent.pdf", { exact: true })
          .count(),
        0,
      );
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await page
        .getByRole("button", {
          name: "Tiếp tục tải lên persistent.pdf",
          exact: true,
        })
        .click();
      await page
        .getByText("Đã lưu vào thư viện.", { exact: true })
        .waitFor({ timeout: 30000 });
      const savedHandleFile = await fixture.prisma.libraryFile.findFirst({
        where: { groupId: group.id, name: "persistent.pdf" },
      });
      assert.equal(savedHandleFile.size, BigInt(16 * 1024 ** 2 + 17));
    } catch (error) {
      if (page && !page.isClosed()) {
        console.error(
          "Upload state:",
          await page
            .locator(".upload-popover")
            .innerText()
            .catch(() => "Unavailable"),
        );
        await page
          .screenshot({
            path: require("node:path").resolve(
              __dirname,
              "../../../.preview/t17-resume-failure.png",
            ),
            fullPage: true,
          })
          .catch(() => {});
      }
      throw error;
    } finally {
      releasePartGate?.();
      if (browser) await browser.close();
      if (fixture) await fixture.cleanup();
    }
  },
);

test(
  "T17 durable queue: reload restores four active files and a fifth file that has not started",
  { timeout: 180000 },
  async () => {
    let fixture, browser, releaseInitial;
    try {
      fixture = await createFrontendFixture({ localUploads: true });
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(30000);
      await page.addInitScript(() => {
        window.fileBytesRead = 0;
        const original = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function (...args) {
          window.fileBytesRead += this.size;
          return original.apply(this, args);
        };
      });
      const email = `parallel-${randomUUID()}@example.test`,
        password = "Parallel-resume-test-123!";
      const registered = await fetch(`${fixture.apiUrl}/auth/register`, {
        method: "POST",
        headers: {
          Origin: fixture.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          fullName: "Parallel upload tester",
        }),
      });
      assert.equal(registered.status, 201);
      const user = (await registered.json()).user;
      const group = await fixture.prisma.group.create({
        data: { name: "Parallel resume", ownerId: user.id },
      });
      await page.goto(`${fixture.webOrigin}/login`);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(`${fixture.webOrigin}/files?groupId=${group.id}`);
      let phase = 0,
        held = 0,
        peak = 0;
      const active = new Set(),
        ids = new Set();
      const initialGate = new Promise((resolve) => {
        releaseInitial = resolve;
      });
      page.on("request", (request) => {
        if (
          phase !== 1 ||
          request.method() !== "PUT" ||
          !request.url().includes("/parts?token=")
        )
          return;
        active.add(request);
        peak = Math.max(peak, active.size);
        const token = new URL(request.url()).searchParams.get("token");
        ids.add(
          JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())
            .id,
        );
      });
      page.on("requestfinished", (request) => active.delete(request));
      page.on("requestfailed", (request) => active.delete(request));
      await page.route("**/parts?token=*", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        if (phase === 0) {
          const count = ++held;
          await page.evaluate((count) => {
            window.initialHeld = Math.max(window.initialHeld ?? 0, count);
          }, count);
          await initialGate;
          await route.continue().catch(() => {});
          return;
        }
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Keep transfers in flight to measure overlap.
        await route.fulfill({ response });
      });
      const files = Array.from({ length: 5 }, (_, i) => ({
        name: `parallel-${i}.pdf`,
        mimeType: "application/pdf",
        buffer: Buffer.alloc(2 * 1024 ** 2, i + 1),
      }));
      await page
        .locator('.file-uploader input[type="file"]')
        .setInputFiles(files);
      await page.waitForFunction(() => window.initialHeld === 4);
      await page
        .locator(".upload-job.queued")
        .filter({ hasText: "parallel-4.pdf" })
        .waitFor();
      assert.equal(
        await fixture.prisma.uploadSession.count({
          where: { userId: user.id },
        }),
        4,
        "The fifth file must not create a server session before it has a slot",
      );
      await page.reload();
      releaseInitial();
      phase = 1;
      await page.waitForFunction(
        () => document.querySelectorAll(".upload-job.paused").length === 5,
      );
      assert.equal(
        await page
          .getByLabel("Chọn lại parallel-4.pdf", { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await fixture.prisma.uploadSession.count({
          where: { userId: user.id },
        }),
        4,
      );
      await page
        .getByRole("button", { name: "Tiếp tục tất cả", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".upload-job.done").length === 5,
      );
      assert.equal(ids.size, 5);
      assert.equal(peak, 4, "All four restored files must upload concurrently");
      assert.equal(
        await page.evaluate(() => window.fileBytesRead),
        2 * 1024 ** 2,
        "Only the fifth, previously unstarted file should need its first fingerprint",
      );
      assert.equal(
        await fixture.prisma.libraryFile.count({
          where: { groupId: group.id, status: "AVAILABLE" },
        }),
        5,
      );
      assert.equal(
        await fixture.prisma.uploadSession.count({
          where: { userId: user.id },
        }),
        5,
        "No duplicate sessions may be created during queue promotion",
      );
      const sourcesLeft = await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("streamora-uploads-v1", 2);
            request.onsuccess = () => {
              const db = request.result,
                count = db
                  .transaction("sources")
                  .objectStore("sources")
                  .count();
              count.onsuccess = () => {
                db.close();
                resolve(count.result);
              };
              count.onerror = () => {
                db.close();
                reject(count.error);
              };
            };
            request.onerror = () => reject(request.error);
          }),
      );
      assert.equal(sourcesLeft, 0);
      console.log(
        `Reloaded queue: ${ids.size} files including one unstarted file, ${peak} simultaneous PUTs; only the unstarted file was hashed`,
      );
    } finally {
      releaseInitial?.();
      if (browser) await browser.close();
      if (fixture) await fixture.cleanup();
    }
  },
);

test(
  "T17 six dropped files wait for quota, including in-flight creations and a temporary 429",
  { timeout: 180000 },
  async () => {
    let fixture, browser, release;
    try {
      fixture = await createFrontendFixture({ localUploads: true });
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(30000);
      const email = `quota-${randomUUID()}@example.test`,
        password = "Upload-quota-queue-123!";
      const registered = await fetch(`${fixture.apiUrl}/auth/register`, {
        method: "POST",
        headers: {
          Origin: fixture.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          fullName: "Quota queue tester",
        }),
      });
      assert.equal(registered.status, 201);
      const user = (await registered.json()).user;
      const group = await fixture.prisma.group.create({
        data: { name: "Quota queue", ownerId: user.id },
      });
      await page.goto(`${fixture.webOrigin}/login`);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(`${fixture.webOrigin}/files?groupId=${group.id}`);
      let held = 0,
        transferring = false,
        newSelection = false,
        injectQuota = true,
        attempts = 0,
        rejectedByServer = 0;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/api/v1/uploads", async (route) => {
        if (!newSelection || route.request().method() !== "POST")
          return route.continue();
        attempts++;
        if (injectQuota) {
          injectQuota = false;
          return route.fulfill({
            status: 429,
            json: {
              error: {
                code: "UPLOAD_QUOTA_EXCEEDED",
                message: "Quota temporarily full",
              },
            },
          });
        }
        const response = await route.fetch();
        if (response.status() === 429) rejectedByServer++;
        await new Promise((resolve) => setTimeout(resolve, 400)); // Server reserved a slot; the browser has no uploadId yet.
        await route.fulfill({ response });
      });
      await page.route("**/parts?token=*", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        if (!transferring) {
          const count = ++held;
          await page.evaluate((count) => {
            window.held = Math.max(window.held ?? 0, count);
          }, count);
          await gate;
          await route.continue().catch(() => {});
          return;
        }
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await route.fulfill({ response });
      });
      await page.locator('.file-uploader input[type="file"]').setInputFiles(
        [0, 1].map((i) => ({
          name: `previous-${i}.pdf`,
          mimeType: "application/pdf",
          buffer: Buffer.alloc(512 * 1024, i + 1),
        })),
      );
      await page.waitForFunction(() => window.held === 2);
      for (const i of [0, 1])
        await page
          .getByRole("button", {
            name: `Tạm dừng tải lên previous-${i}.pdf`,
            exact: true,
          })
          .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".upload-job.paused").length === 2,
      );
      newSelection = true;
      const dropped = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        for (let i = 0; i < 6; i++)
          data.items.add(
            new File(
              [new Uint8Array(2 * 1024 ** 2).fill(i + 10)],
              `drop-${i}.pdf`,
              { type: "application/pdf" },
            ),
          );
        return data;
      });
      await page
        .locator(".file-uploader")
        .dispatchEvent("drop", { dataTransfer: dropped });
      await dropped.dispose();
      await page
        .getByText("Đang chờ lượt trống từ máy chủ…", { exact: true })
        .first()
        .waitFor();
      await page.waitForFunction(() => window.held === 4);
      assert.equal(
        attempts,
        3,
        "Only two new sessions may be accepted alongside two paused sessions, plus the single rejected probe",
      );
      assert.equal(
        rejectedByServer,
        0,
        "In-flight creations must count toward the remaining quota",
      );
      assert.equal(await page.locator(".upload-job.error").count(), 0);
      assert.equal(
        await fixture.prisma.uploadSession.count({
          where: { userId: user.id, status: "ACTIVE" },
        }),
        4,
      );
      transferring = true;
      release();
      await page.waitForFunction(
        () => document.querySelectorAll(".upload-job.done").length === 6,
      );
      assert.equal(await page.locator(".upload-job.error").count(), 0);
      assert.equal(rejectedByServer, 0);
      assert.equal(
        attempts,
        7,
        "Six accepted sessions and one quota rejection; no duplicate creation",
      );
      assert.equal(
        await fixture.prisma.libraryFile.count({
          where: { groupId: group.id, status: "AVAILABLE" },
        }),
        6,
      );
      assert.equal(
        await fixture.prisma.uploadSession.count({
          where: { userId: user.id, status: "ACTIVE" },
        }),
        2,
        "Previously paused uploads must be preserved, not aborted to force free slots",
      );
      console.log(
        "Six dropped files completed; two paused uploads preserved; temporary quota response stayed queued and retried automatically",
      );
    } finally {
      release?.();
      if (browser) await browser.close();
      if (fixture) await fixture.cleanup();
    }
  },
);
