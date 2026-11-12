const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { mkdir, writeFile, rm } = require("node:fs/promises");
const { resolve } = require("node:path");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");
let fixture, browser;
before(
  async () => {
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === "win32" ? "msedge" : undefined,
    });
    fixture = await createFrontendFixture({ localUploads: true });
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

test(
  "T15 library UI: real list, search, pagination, rename, delete, mobile and revoked access",
  { timeout: 90000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.route("https://fonts.googleapis.com/**", (route) =>
      route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    try {
      const email = `files-${randomUUID()}@example.test`,
        password = "Files-test-password-123!";
      const response = await fetch(`${fixture.apiUrl}/auth/register`, {
        method: "POST",
        headers: {
          Origin: fixture.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          fullName: "Người thử thư viện",
        }),
      });
      assert.equal(response.status, 201);
      const user = (await response.json()).user;
      const owner = await fixture.prisma.user.create({
        data: {
          email: `owner-${randomUUID()}@example.test`,
          fullName: "Chủ nhóm",
          passwordHash: await require("argon2").hash("T15-test-only-password!"),
        },
      });
      const group = await fixture.prisma.group.create({
        data: { name: "Nhóm thư viện T15", ownerId: owner.id },
      });
      await fixture.prisma.groupMember.create({
        data: { groupId: group.id, userId: user.id, role: "VIEWER" },
      });
      const data = Array.from({ length: 23 }, (_, i) => ({
        name: `Tài liệu ${String(i).padStart(2, "0")}.pdf`,
        groupId: group.id,
        createdBy: user.id,
        objectKey: `test/${randomUUID()}`,
        size: 2048n,
        status: "AVAILABLE",
        mimeType: "application/pdf",
        source: "DOCUMENT",
      }));
      await fixture.prisma.libraryFile.createMany({ data });
      const cloud = await fixture.prisma.libraryFile.create({
        data: {
          ...data[0],
          name: "Bản ghi cloud.mp4",
          objectKey: `test/${randomUUID()}`,
          createdBy: owner.id,
          mimeType: "video/mp4",
          source: "CLOUD_RECORDING",
          status: "PENDING",
        },
      });
      await page.goto(`${fixture.webOrigin}/login`);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(`${fixture.webOrigin}/files?groupId=${group.id}`);
      await page
        .getByRole("button", { name: "Làm mới", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Xem thêm", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll(".library-file-row").length === 24,
      );
      assert.equal(await page.locator(".library-file-row").count(), 24);
      assert.equal(
        await page.locator(".upload-choice").count(),
        0,
        "Viewer must not see upload controls",
      );
      assert.equal(
        await page
          .getByRole("button", {
            name: "Tải xuống Bản ghi cloud.mp4",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Xóa Bản ghi cloud.mp4", exact: true })
          .count(),
        0,
      );
      const search = page.getByRole("textbox", { name: "Tìm tên tài liệu" });
      await search.fill("Tài liệu 00");
      await page.waitForFunction(
        () => document.querySelectorAll(".library-file-row").length === 1,
      );
      let previewRequests = 0;
      await page.route("**/api/v1/files/*/preview-url", async (route) => {
        previewRequests++;
        if (previewRequests === 1)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: "STORAGE_UNAVAILABLE",
                message: "Preview temporarily unavailable",
              },
              requestId: "preview-test",
            },
          });
        return route.fulfill({
          json: {
            url: `${fixture.webOrigin}/test-preview.pdf`,
            expiresAt: new Date(Date.now() + 120000).toISOString(),
          },
        });
      });
      await page.route(`${fixture.webOrigin}/test-preview.pdf`, (route) =>
        route.fulfill({
          contentType: "application/pdf",
          headers: { "content-disposition": "inline" },
          body: require("../pdf-fixture.cjs").pdfFixture(),
        }),
      );
      await page
        .getByRole("button", { name: "Xem trước Tài liệu 00.pdf", exact: true })
        .click();
      const pdfDialog = page.getByRole("dialog", {
        name: "Xem trước PDF",
        exact: true,
      });
      await pdfDialog.getByRole("alert").waitFor();
      await pdfDialog
        .getByRole("button", { name: "Tải lại bản xem trước", exact: true })
        .click();
      await page.waitForFunction(
        () => !!document.querySelector(".library-preview-body iframe"),
      );
      assert.equal(
        await pdfDialog.locator("iframe").getAttribute("src"),
        `${fixture.webOrigin}/test-preview.pdf`,
      );
      await page.waitForLoadState("networkidle");
      await mkdir(resolve(".preview/t15-qa"), { recursive: true });
      await page.screenshot({
        path: resolve(".preview/t15-qa/pdf-preview-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: resolve(".preview/t15-qa/pdf-preview-mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await pdfDialog
        .getByRole("button", { name: "Đóng", exact: true })
        .first()
        .click();
      await pdfDialog.waitFor({ state: "hidden" });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page
        .getByRole("button", { name: "Đổi tên Tài liệu 00.pdf", exact: true })
        .click();
      await page
        .getByLabel("Tên tài liệu", { exact: true })
        .fill("Bài giảng mới.pdf");
      await page.getByRole("button", { name: "Lưu tên", exact: true }).click();
      await page
        .locator('dialog[aria-labelledby="library-dialog-title"]')
        .waitFor({ state: "hidden" });
      for (const button of await page
        .getByRole("button", { name: "Đóng thông báo", exact: true })
        .all())
        await button.click();
      await search.fill("Bài giảng mới");
      await page
        .getByRole("button", { name: "Xóa Bài giảng mới.pdf", exact: true })
        .waitFor();
      await mkdir(resolve(".preview/t15-qa"), { recursive: true });
      await page.screenshot({
        path: resolve(".preview/t15-qa/library-desktop.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Xóa Bài giảng mới.pdf", exact: true })
        .click();
      await page
        .getByText("Tài liệu sẽ bị xóa vĩnh viễn và không thể khôi phục.", {
          exact: false,
        })
        .waitFor();
      await page
        .getByRole("button", { name: "Xóa vĩnh viễn", exact: true })
        .click();
      await page.getByText("Chưa tìm thấy tài liệu", { exact: true }).waitFor();
      assert.equal(
        await fixture.prisma.libraryFile.count({
          where: { groupId: group.id, status: "DELETED" },
        }),
        1,
      );
      await search.fill("");
      await page
        .getByRole("button", { name: "Video và bản ghi", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".library-file-row").length === 1,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      for (const button of await page
        .getByRole("button", { name: "Đóng thông báo", exact: true })
        .all())
        await button.click();
      await page.screenshot({
        path: resolve(".preview/t15-qa/library-mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      // New file list and download requests must fail after membership removal.
      await fixture.prisma.groupMember.delete({
        where: { userId_groupId: { userId: user.id, groupId: group.id } },
      });
      await page.getByRole("button", { name: "Làm mới", exact: true }).click();
      await page
        .getByText("Bạn chưa có quyền truy cập", { exact: true })
        .waitFor();
      assert.equal(await page.locator(".library-file-row").count(), 0);
    } finally {
      await context.close();
    }
  },
);

test(
  "T15 folders UI: directory upload, hover, nested file search, ZIP, rename, delete and empty layout",
  { timeout: 120000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 850 },
      acceptDownloads: true,
    });
    const root = resolve(".preview", `folder-ui-${randomUUID()}`);
    const materials = resolve(root, "Materials");
    try {
      await mkdir(resolve(materials, "Sub"), { recursive: true });
      await writeFile(
        resolve(materials, "Sub", "nested.txt"),
        "folder fixture",
      );
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          message.text().includes("Maximum update depth")
        )
          errors.push(message.text());
      });
      const email = `folder-${randomUUID()}@example.test`,
        password = "Folders-test-password-123!";
      const registered = await fetch(`${fixture.apiUrl}/auth/register`, {
        method: "POST",
        headers: {
          Origin: fixture.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, fullName: "Folder tester" }),
      });
      assert.equal(registered.status, 201);
      const user = (await registered.json()).user;
      const group = await fixture.prisma.group.create({
        data: { name: "Folder UI", ownerId: user.id },
      });
      await page.goto(`${fixture.webOrigin}/login`);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(`${fixture.webOrigin}/files?groupId=${group.id}`);
      await page
        .getByText("Thư viện chưa có tài liệu", { exact: true })
        .waitFor();
      assert.equal(await page.locator(".file-table-heading").count(), 0);
      await page.locator(".upload-choice summary").click();
      assert.equal(
        await page
          .getByRole("button", { name: "Chọn thư mục", exact: true })
          .isVisible(),
        true,
      );
      await page.locator(".upload-choice summary").click();
      const transfer = await page.evaluateHandle(() => {
        const d = new DataTransfer();
        d.items.add(new File(["test"], "test.txt", { type: "text/plain" }));
        return d;
      });
      await page
        .locator(".file-uploader")
        .dispatchEvent("dragenter", { dataTransfer: transfer });
      assert.match(
        await page.locator(".file-uploader").getAttribute("class"),
        /is-dragging/,
      );
      await page
        .locator(".file-uploader")
        .dispatchEvent("dragleave", { dataTransfer: transfer });
      assert.doesNotMatch(
        await page.locator(".file-uploader").getAttribute("class"),
        /is-dragging/,
      );
      await page
        .locator(".file-uploader input[webkitdirectory]")
        .setInputFiles(materials);
      await page
        .locator(".library-file-name")
        .filter({ hasText: "Materials" })
        .waitFor();
      const saved = await fixture.prisma.libraryFile.findFirst({
        where: { groupId: group.id },
      });
      assert.equal(saved.folderPath, "Materials/Sub");
      await page
        .getByRole("button", { name: "Video và bản ghi", exact: true })
        .click();
      await page.getByText("Chưa tìm thấy tài liệu", { exact: true }).waitFor();
      assert.equal(await page.locator(".library-file-row").count(), 0);
      await page.getByRole("button", { name: "Tài liệu", exact: true }).click();
      await page
        .locator(".library-file-name")
        .filter({ hasText: "Materials" })
        .waitFor();
      const search = page.getByRole("textbox", { name: "Tìm tên tài liệu" });
      await search.fill("nested");
      await page
        .getByRole("button", { name: "Tải xuống nested.txt", exact: true })
        .waitFor();
      assert.equal(await page.locator(".library-file-row").count(), 1);
      assert.equal(
        await page
          .getByRole("button", {
            name: "Tải xuống thư mục Materials",
            exact: true,
          })
          .count(),
        0,
      );
      await search.fill("missing-file");
      await page.getByText("Chưa tìm thấy tài liệu", { exact: true }).waitFor();
      assert.equal(await page.locator(".file-table-heading").count(), 0);
      await page.setViewportSize({ width: 375, height: 850 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.setViewportSize({ width: 1000, height: 850 });
      await search.fill("");
      await page
        .getByRole("button", {
          name: "Tải xuống thư mục Materials",
          exact: true,
        })
        .waitFor();
      const downloadPromise = page.waitForEvent("download");
      await page
        .getByRole("button", {
          name: "Tải xuống thư mục Materials",
          exact: true,
        })
        .click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), "Materials.zip");
      assert.equal(await download.failure(), null);
      await page
        .getByRole("button", { name: "Đổi tên thư mục Materials", exact: true })
        .click();
      const rename = page.getByRole("dialog", {
        name: "Đổi tên thư mục",
        exact: true,
      });
      await rename.getByLabel("Tên thư mục").fill("Renamed");
      await rename
        .getByRole("button", { name: "Lưu tên", exact: true })
        .click();
      await rename.waitFor({ state: "hidden" });
      await page
        .getByRole("button", { name: "Xóa thư mục Renamed", exact: true })
        .click();
      const deletion = page.getByRole("dialog", {
        name: "Xóa vĩnh viễn thư mục?",
        exact: true,
      });
      await deletion
        .getByRole("button", { name: "Xóa vĩnh viễn", exact: true })
        .click();
      await deletion.waitFor({ state: "hidden" });
      await page.getByText("Chưa tìm thấy tài liệu", { exact: true }).waitFor();
      assert.equal(
        (
          await fixture.prisma.libraryFile.findUnique({
            where: { id: saved.id },
          })
        ).status,
        "DELETED",
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      if (!root.startsWith(resolve(".preview") + require("node:path").sep))
        throw Error("Unsafe cleanup path");
      await rm(root, { recursive: true, force: true });
    }
  },
);
