const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");
test(
  "T16 browser: multipart checksum, cancel, multi-file isolation, auto-hide popup and image/PDF previews",
  { timeout: 240000 },
  async () => {
    let fixture, browser;
    try {
      fixture = await createFrontendFixture({ localUploads: true });
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(30000);
      const email = `t16-${randomUUID()}@example.test`,
        password = "Upload-test-password-123!";
      const register = await fetch(`${fixture.apiUrl}/auth/register`, {
        method: "POST",
        headers: {
          Origin: fixture.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          fullName: "Người tải tài liệu",
        }),
      });
      assert.equal(register.status, 201);
      const user = (await register.json()).user;
      const group = await fixture.prisma.group.create({
        data: { name: "Nhóm tải lên T16", ownerId: user.id },
      });
      await page.goto(`${fixture.webOrigin}/login`);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(`${fixture.webOrigin}/files?groupId=${group.id}`);
      let activeParts = 0,
        peakParts = 0;
      page.on("request", (request) => {
        if (
          request.method() === "PUT" &&
          request.url().includes("/parts?token=")
        ) {
          activeParts++;
          peakParts = Math.max(peakParts, activeParts);
        }
      });
      page.on("requestfinished", (request) => {
        if (
          request.method() === "PUT" &&
          request.url().includes("/parts?token=")
        )
          activeParts--;
      });
      const buffer = Buffer.alloc(40 * 1024 ** 2 + 33, 42);
      await page.locator('.file-uploader input[type="file"]').setInputFiles({
        name: "Tai-lieu-T16.pdf",
        mimeType: "application/pdf",
        buffer,
      });
      await page
        .getByText("Đã lưu vào thư viện.", { exact: true })
        .waitFor({ timeout: 90000 });
      assert.equal(
        await page.locator(".upload-popover progress").getAttribute("value"),
        "100",
      );
      const saved = await fixture.prisma.libraryFile.findFirst({
        where: { groupId: group.id },
      });
      assert.equal(saved.status, "AVAILABLE");
      assert.equal(peakParts, 5);
      assert.equal(Number(saved.size), buffer.length);
      await page
        .getByRole("button", {
          name: "Tải xuống Tai-lieu-T16.pdf",
          exact: true,
        })
        .waitFor();
      const downloadEvent = page.waitForEvent("download");
      await page
        .getByRole("button", {
          name: "Tải xuống Tai-lieu-T16.pdf",
          exact: true,
        })
        .click();
      const download = await downloadEvent;
      const stream = await download.createReadStream(),
        hash = createHash("sha256");
      for await (const chunk of stream) hash.update(chunk);
      assert.equal(
        hash.digest("hex"),
        createHash("sha256").update(buffer).digest("hex"),
      );
      // Hold the next PUT until the UI cancels it; the control API remains real.
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/parts?token=**", async (route) => {
        await gate;
        await route.abort().catch(() => {});
      });
      await page.locator('.file-uploader input[type="file"]').setInputFiles({
        name: "Huy-T16.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.alloc(1000),
      });
      await page
        .getByRole("button", { name: "Hủy tải lên Huy-T16.pdf", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Hủy tải lên Huy-T16.pdf", exact: true })
        .click();
      release();
      await page.getByText("Đã hủy tải lên.", { exact: true }).waitFor();
      assert.equal(
        await fixture.prisma.libraryFile.count({
          where: { groupId: group.id },
        }),
        1,
      );
      assert.equal(
        await fixture.prisma.uploadSession.count({
          where: { groupId: group.id, status: "ABORTED" },
        }),
        1,
      );
      await page.unroute("**/parts?token=**");
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      );
      await page.locator('.file-uploader input[type="file"]').setInputFiles([
        {
          name: "Khong-ho-tro.html",
          mimeType: "text/html",
          buffer: Buffer.from("<p>unsupported</p>"),
        },
        { name: "Anh-T16.png", mimeType: "image/png", buffer: png },
        {
          name: "Van-ban-T16.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Nhiều file cùng lúc"),
        },
        {
          name: "PDF-T16.pdf",
          mimeType: "application/pdf",
          buffer: require("../pdf-fixture.cjs").pdfFixture(),
        },
      ]);
      await page.waitForFunction(() =>
        ["Anh-T16.png", "Van-ban-T16.txt", "PDF-T16.pdf"].every((name) =>
          [...document.querySelectorAll(".upload-job.done")].some((row) =>
            row.textContent.includes(name),
          ),
        ),
      );
      assert.equal(
        await fixture.prisma.libraryFile.count({
          where: { groupId: group.id },
        }),
        4,
      );
      await page
        .locator(".upload-job.error")
        .filter({ hasText: "Khong-ho-tro.html" })
        .waitFor();
      await page
        .getByRole("button", {
          name: "Đóng trạng thái Khong-ho-tro.html",
          exact: true,
        })
        .click();
      // Successful rows leave the popup automatically, not only when manually closed.
      await page
        .locator(".upload-popover")
        .waitFor({ state: "detached", timeout: 8000 });
      await page
        .getByRole("button", { name: "Xem trước Anh-T16.png", exact: true })
        .click();
      await page.waitForFunction(() => {
        const img = document.querySelector(".library-preview-image");
        return img?.complete && img.naturalWidth > 0;
      });
      assert.equal(
        await page
          .getByRole("heading", { name: "Xem trước ảnh", exact: true })
          .count(),
        1,
      );
      await page
        .locator("dialog")
        .getByRole("button", { name: "Đóng", exact: true })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Xem trước PDF-T16.pdf", exact: true })
        .click();
      await page.locator(".library-preview-body iframe").waitFor();
      await page
        .locator("dialog")
        .getByRole("button", { name: "Đóng", exact: true })
        .first()
        .click();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
    } finally {
      if (browser) await browser.close();
      if (fixture) await fixture.cleanup();
    }
  },
);
