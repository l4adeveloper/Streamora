const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const { createFrontendFixture } = require("./frontend-fixture.cjs");

test(
  "Record is explicit, toggles to Stop, survives reload; failed End stays in the meeting and retry really ends it",
  { timeout: 180000 },
  async () => {
    let fixture, browser, heldState;
    try {
      fixture = await createFrontendFixture({ localUploads: true });
      const password = "Meeting-controls-password-123!";
      const email = `controls-${randomUUID()}@example.test`;
      const registered = await fetch(fixture.apiUrl + "/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: fixture.webOrigin,
        },
        body: JSON.stringify({ email, password, fullName: "Chủ cuộc họp" }),
      });
      assert.equal(registered.status, 201);
      const { user } = await registered.json();
      const group = await fixture.prisma.group.create({
        data: { name: "Recording controls", ownerId: user.id },
      });
      const session = await fixture.prisma.classSession.create({
        data: {
          kind: "GROUP",
          groupId: group.id,
          createdById: user.id,
          title: "Record rồi kết thúc",
          joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
          status: "LIVE",
          scheduledAt: new Date(),
          startedAt: new Date(),
        },
      });
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let recording = null,
        starts = 0,
        stops = 0,
        firstGet = true;
      const headers = {
        "Access-Control-Allow-Origin": fixture.webOrigin,
        "Access-Control-Allow-Credentials": "true",
        "Content-Type": "application/json",
      };
      const state = () => ({
        recording,
        canRecord: false,
        groupId: group.id,
        title: session.title,
      });
      await page.route(
        new RegExp(`/sessions/${session.id}/recording(?:s(?:/[^/]+/stop)?)?$`),
        async (route) => {
          const request = route.request();
          if (request.method() === "OPTIONS")
            return route.fulfill({
              status: 204,
              headers: {
                ...headers,
                "Access-Control-Allow-Headers":
                  "Content-Type,Authorization,Idempotency-Key",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
              },
            });
          if (request.method() === "GET") {
            if (firstGet) {
              firstGet = false;
              heldState = route;
              return;
            }
            return route.fulfill({ status: 200, headers, json: state() });
          }
          if (new URL(request.url()).pathname.endsWith("/stop")) {
            stops++;
            recording = {
              ...recording,
              status: "SAVING",
              stoppedAt: new Date().toISOString(),
              version: 2,
            };
          } else {
            starts++;
            assert.ok(request.postDataJSON().participationId);
            recording = {
              id: randomUUID(),
              sessionId: session.id,
              status: "RECORDING",
              starting: false,
              recorderId: user.id,
              recorderName: user.fullName,
              startedAt: new Date().toISOString(),
              stoppedAt: null,
              fileId: null,
              presenter: null,
              version: 1,
              layout: { cameraPosition: "bottom-right", cameraVisible: true },
            };
          }
          return route.fulfill({ status: 200, headers, json: { recording } });
        },
      );
      await page.goto(fixture.webOrigin + "/login");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      const url = `${fixture.webOrigin}/workspace?groupId=${group.id}&meetingId=${session.id}`;
      await page.goto(url);
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      const record = page.getByRole("button", {
        name: "Ghi hình buổi học",
        exact: true,
      });
      await record.waitFor();
      assert.equal(await record.isEnabled(), true);
      assert.equal(starts, 0, "Entering the room must never start recording");
      await record.click();
      const stop = page.getByRole("button", {
        name: "Dừng ghi hình",
        exact: true,
      });
      await stop.waitFor();
      assert.equal(starts, 1);
      if (heldState) {
        await heldState.fulfill({
          status: 200,
          headers,
          json: { ...state(), recording: null },
        });
        heldState = null;
      }
      await page.waitForTimeout(200);
      assert.equal(
        await stop.count(),
        1,
        "A stale state response must not undo Record",
      );
      await page.reload();
      await stop.waitFor();
      assert.equal(
        starts,
        1,
        "Reload must resume the existing state, not create a recording",
      );
      assert.equal(stops, 0, "Leaving/reloading must not send Stop");
      let failAdmission = true;
      const admissionUrl = `**/sessions/${session.id}/admission`;
      await page.route(admissionUrl, (route) => {
        if (route.request().method() !== "GET" || !failAdmission)
          return route.continue();
        failAdmission = false;
        return route.fulfill({
          status: 503,
          headers,
          json: { error: { code: "SERVICE_UNAVAILABLE" } },
        });
      });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page
        .getByText("Dịch vụ tạm thời chưa sẵn sàng. Vui lòng thử lại sau.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await stop.count(),
        1,
        "A transient refresh failure must keep the in-room media component mounted",
      );
      await page.unroute(admissionUrl);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      await stop.click();
      await page
        .getByText("Đang hoàn tất bản ghi trên S3…", { exact: true })
        .waitFor();
      assert.equal(
        stops,
        1,
        "The second press must stop recording exactly once",
      );
      recording = { ...recording, errorCode: "AccessDenied" };
      await page
        .getByText(
          "Lưu bản ghi đang gặp lỗi. Máy chủ sẽ tự thử lại; bạn có thể rời phòng.",
          { exact: true },
        )
        .waitFor();

      // A failed End must show the error, keep the room open, and allow a real retry.
      const endUrl = `**/sessions/${session.id}/end`;
      await page.route(endUrl, (route) =>
        route.request().method() === "OPTIONS"
          ? route.continue()
          : route.fulfill({
              status: 503,
              headers,
              json: {
                error: {
                  code: "TEST_END_UNAVAILABLE",
                  message: "Chưa kết thúc được cuộc họp. Hãy thử lại.",
                },
              },
            }),
      );
      await page
        .getByRole("button", { name: "Quản lý phòng", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Quản lý cuộc họp",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Kết thúc buổi học", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Xác nhận kết thúc", exact: true })
        .click();
      await dialog
        .getByText("Dịch vụ tạm thời chưa sẵn sàng. Vui lòng thử lại sau.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        new URL(page.url()).searchParams.get("meetingId"),
        session.id,
      );
      assert.equal(
        (
          await fixture.prisma.classSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).status,
        "LIVE",
      );
      await page.unroute(endUrl);
      await fixture.prisma.classRecording.create({
        data: {
          id: recording.id,
          sessionId: session.id,
          recorderId: user.id,
          provider: "IVS",
          status: "SAVING",
          stoppedAt: new Date(),
        },
      });
      const ended = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/sessions/${session.id}/end`) &&
          response.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: "Xác nhận kết thúc", exact: true })
        .click();
      assert.equal((await ended).status(), 200);
      await page
        .getByText(
          "Đang lưu bản ghi trước khi kết thúc cuộc họp. Phòng sẽ đóng sau khi lưu thành công.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        new URL(page.url()).searchParams.get("meetingId"),
        session.id,
      );
      assert.equal(
        (
          await fixture.prisma.classSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).status,
        "LIVE",
      );
      const file = await fixture.prisma.libraryFile.create({
        data: {
          groupId: group.id,
          sessionId: session.id,
          createdBy: user.id,
          name: "Meeting.mp4",
          objectKey: `recording/${randomUUID()}.mp4`,
          size: 100n,
          mimeType: "video/mp4",
          source: "CLOUD_RECORDING",
          status: "AVAILABLE",
        },
      });
      await fixture.prisma.classRecording.update({
        where: { id: recording.id },
        data: { status: "SAVED", fileId: file.id },
      });
      await fixture.app
        .get(
          require("../../dist/modules/class-sessions/class-sessions.service")
            .ClassSessionsService,
        )
        .finishRequestedEnd(session.id);
      await page.waitForFunction(
        () => !new URLSearchParams(location.search).has("meetingId"),
      );
      assert.equal(
        (
          await fixture.prisma.classSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).status,
        "ENDED",
      );
      assert.equal(
        await fixture.prisma.classParticipation.count({
          where: { sessionId: session.id, leftAt: null },
        }),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      if (heldState) await heldState.abort().catch(() => {});
      if (browser) await browser.close();
      if (fixture) await fixture.cleanup();
    }
  },
);
