const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");

test(
  "browsing files and recordings keeps the same meeting mounted and admitted until explicit Leave",
  { timeout: 180000 },
  async () => {
    let fixture, browser;
    try {
      fixture = await createFrontendFixture({ localUploads: true });
      const email = `library-nav-${randomUUID()}@example.test`,
        password = "Library-nav-password-123!";
      const response = await fetch(fixture.apiUrl + "/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: fixture.webOrigin,
        },
        body: JSON.stringify({
          email,
          password,
          fullName: "Chủ phòng thư viện",
        }),
      });
      assert.equal(response.status, 201);
      const { user } = await response.json();
      const db = fixture.prisma;
      const group = await db.group.create({
        data: { name: "Học và xem tài liệu", ownerId: user.id },
      });
      const lesson = await db.classSession.create({
        data: {
          kind: "GROUP",
          groupId: group.id,
          createdById: user.id,
          title: "Cuộc họp liên tục",
          joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
          status: "LIVE",
          startedAt: new Date(),
          scheduledAt: new Date(),
        },
      });
      await db.libraryFile.createMany({
        data: [
          {
            name: "Tài liệu đang họp.pdf",
            mimeType: "application/pdf",
            source: "DOCUMENT",
          },
          {
            name: "Bài giảng đã ghi.mp4",
            mimeType: "video/mp4",
            source: "CLOUD_RECORDING",
          },
        ].map((file) => ({
          ...file,
          groupId: group.id,
          createdBy: user.id,
          objectKey: `nav/${randomUUID()}`,
          size: 100n,
          status: "AVAILABLE",
        })),
      });
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(20000);
      const errors = [],
        leaves = [],
        entries = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        if (
          request.url().includes(`/sessions/${lesson.id}/`) &&
          request.url().endsWith("/leave")
        )
          leaves.push(request.url());
        if (request.url().endsWith(`/sessions/${lesson.id}/enter`))
          entries.push(request.url());
      });
      await page.goto(fixture.webOrigin + "/login");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(
        `${fixture.webOrigin}/workspace?groupId=${group.id}&meetingId=${lesson.id}`,
      );
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      const original = await db.classParticipation.findFirstOrThrow({
        where: { sessionId: lesson.id, userId: user.id, leftAt: null },
      });
      await page.evaluate(() => {
        window.savedMeetingNode = document.querySelector(
          ".workspace-meeting-frame .meeting-room",
        );
      });
      const assertKept = async () => {
        assert.equal(
          new URL(page.url()).searchParams.get("meetingId"),
          lesson.id,
        );
        assert.equal(new URL(page.url()).searchParams.get("groupId"), group.id);
        assert.equal(
          await page.evaluate(
            () =>
              !!window.savedMeetingNode &&
              window.savedMeetingNode.isConnected &&
              window.savedMeetingNode ===
                document.querySelector(
                  ".workspace-meeting-frame .meeting-room",
                ),
          ),
          true,
          "The meeting and its media hooks must remain mounted",
        );
        assert.equal(
          (
            await db.classParticipation.findUniqueOrThrow({
              where: { id: original.id },
            })
          ).leftAt,
          null,
        );
        assert.equal(
          await db.classParticipation.count({
            where: { sessionId: lesson.id, userId: user.id },
          }),
          1,
        );
        assert.equal(
          entries.length,
          1,
          "Browsing must not create another participation",
        );
        assert.deepEqual(
          leaves,
          [],
          "Browsing must not send meeting or media Leave",
        );
      };
      const banner = page.getByRole("complementary", {
        name: "Cuộc họp đang diễn ra",
        exact: true,
      });
      await page
        .getByRole("link", { name: "Tài liệu chung", exact: true })
        .click();
      await page.getByText("Tài liệu đang họp.pdf", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/files");
      await banner.waitFor();
      assert.equal(
        await page.locator(".workspace-meeting-frame").isVisible(),
        false,
      );
      await assertKept();
      await page
        .getByRole("link", { name: "Bản ghi bài giảng", exact: true })
        .click();
      await page.getByText("Bài giảng đã ghi.mp4", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("type"), "recordings");
      assert.equal(
        await page.getByText("Tài liệu đang họp.pdf", { exact: true }).count(),
        0,
      );
      await assertKept();
      await page.goBack();
      await page.getByText("Tài liệu đang họp.pdf", { exact: true }).waitFor();
      await assertKept();
      await page.goBack();
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      assert.equal(
        await page.locator(".workspace-meeting-frame").isVisible(),
        true,
      );
      await assertKept();
      await page.goForward();
      await page.getByText("Tài liệu đang họp.pdf", { exact: true }).waitFor();
      await assertKept();
      await banner
        .getByRole("button", { name: "Quay lại cuộc họp", exact: true })
        .click();
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      await assertKept();
      await page
        .getByRole("link", { name: "Bản ghi bài giảng", exact: true })
        .click();
      await banner
        .getByRole("button", { name: "Rời phòng", exact: true })
        .click();
      await banner.waitFor({ state: "detached" });
      assert.equal(
        (
          await db.classParticipation.findUniqueOrThrow({
            where: { id: original.id },
          })
        ).leaveReason,
        "LEFT",
      );
      assert.equal(await page.locator(".workspace-meeting-frame").count(), 0);
      assert.equal(new URL(page.url()).searchParams.has("meetingId"), false);
      assert.ok(leaves.length >= 1);
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      if (fixture) await fixture.cleanup();
    }
  },
);
