const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn, execFile } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { mkdirSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");

test(
  "Browser handles T05 media controls and restores a T09 poll choice after refresh",
  { timeout: 120000 },
  async (t) => {
    const root = resolve(__dirname, "../../..");
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const web = spawn(
      process.execPath,
      [
        resolve(root, "node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: process.env.STREAMORA_TEST_WEB_ROOT ?? resolve(root, "frontend"),
        env: { ...process.env, NODE_ENV: "production" },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    let browser;
    try {
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          const response = await fetch(origin);
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(ready, "Next.js production server should start");
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
        ],
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const sessionId = randomUUID(),
        participationId = randomUUID();
      const user = {
        id: randomUUID(),
        fullName: "Người kiểm thử",
        email: "media-ui@example.test",
        globalRole: "USER",
      };
      const session = {
        id: sessionId,
        kind: "MEET",
        groupId: null,
        createdById: user.id,
        title: "Lớp học thử nghiệm",
        description: "Kiểm tra mic và camera",
        joinCode: "123456789ABC",
        status: "LIVE",
        scheduledAt: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        cancelledAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const participation = {
        id: participationId,
        sessionId,
        userId: user.id,
        joinRequestId: null,
        joinedAt: new Date().toISOString(),
        leftAt: null,
        leaveReason: null,
      };
      const listener = { id: randomUUID(), fullName: "Người nghe" };
      const listenerVisitId = randomUUID();
      const joins = [];
      let joinFailures = [];
      let poll = null;
      let pollTest = true;
      await context.route("https://fonts.googleapis.com/**", (route) =>
        route.abort(),
      );
      await context.route("**/api/v1/**", async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        const headers = {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, Idempotency-Key",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
        };
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers });
        let body;
        if (path.endsWith("/auth/refresh"))
          body = { accessToken: "test-bearer", expiresIn: 900, user };
        else if (path.endsWith("/users/me")) body = { user };
        else if (
          path.endsWith("/access") ||
          path === `/api/v1/meets/${session.joinCode}`
        )
          body = {
            meet: {
              id: sessionId,
              title: session.title,
              host: user,
              status: "LIVE",
              groupId: null,
              allowGuests: false,
              mode: "STANDALONE",
              joinCode: session.joinCode,
            },
          };
        else if (path.endsWith("/admission"))
          body = {
            request: null,
            participation,
            permissions: {
              canManage: true,
              canRequestJoin: false,
              canEnter: false,
              canViewParticipants: true,
              canViewPolls: pollTest,
            },
          };
        else if (path.endsWith("/participants"))
          body = {
            items: [
              {
                ...participation,
                user,
                media: {
                  connected: false,
                  micEnabled: null,
                  cameraEnabled: null,
                  checkedAt: null,
                },
              },
              {
                ...participation,
                id: listenerVisitId,
                userId: listener.id,
                user: listener,
              },
            ],
            nextCursor: null,
          };
        else if (path === `/api/v1/sessions/${sessionId}/polls`) {
          if (request.method() === "POST") {
            const input = request.postDataJSON();
            poll = {
              id: randomUUID(),
              sessionId,
              question: input.question,
              options: input.options.map(({ text }) => ({
                id: randomUUID(),
                text,
                count: 0,
              })),
              totalVotes: 0,
              myOptionId: null,
              version: "1",
              status: "OPEN",
            };
            body = { poll };
          } else body = { items: poll ? [poll] : [], nextCursor: null };
        } else if (poll && path === `/api/v1/polls/${poll.id}/vote`) {
          const { optionId } = request.postDataJSON();
          poll = {
            ...poll,
            totalVotes: 1,
            myOptionId: optionId,
            version: "2",
            options: poll.options.map((option) => ({
              ...option,
              count: Number(option.id === optionId),
            })),
          };
          body = { poll };
        } else if (poll && path === `/api/v1/polls/${poll.id}/close`) {
          poll = { ...poll, status: "CLOSED", version: "3" };
          body = { poll };
        } else if (path === `/api/v1/sessions/${sessionId}`) body = { session };
        else if (path.endsWith("/join")) {
          joins.push(request.postDataJSON());
          const code = joinFailures.shift() ?? "MEDIA_UNAVAILABLE";
          return route.fulfill({
            status: code === "MEDIA_UNAVAILABLE" ? 503 : 409,
            headers,
            body: JSON.stringify({
              error: { code, message: "Test response" },
              requestId: randomUUID(),
            }),
          });
        } else body = { items: [], nextCursor: null };
        return route.fulfill({
          status: 200,
          headers,
          body: JSON.stringify(body),
        });
      });
      await t.test(
        "T09 creates, votes, restores the choice after refresh, and closes",
        async () => {
          const pollPage = await context.newPage();
          try {
            await pollPage.goto(`${origin}/sessions/${sessionId}`);
            const polls = pollPage.getByRole("region", {
              name: "Bình chọn trong buổi học",
            });
            await polls.getByRole("button", { name: "Tạo bình chọn" }).click();
            await polls.getByLabel("Câu hỏi").fill("Học phần nào tiếp theo?");
            await polls
              .getByLabel("Lựa chọn 1", { exact: true })
              .fill("Mạng máy tính");
            await polls
              .getByLabel("Lựa chọn 2", { exact: true })
              .fill("Cơ sở dữ liệu");
            await polls.getByRole("button", { name: "Mở bình chọn" }).click();
            const selected = polls.getByRole("button", {
              name: /Cơ sở dữ liệu/,
            });
            await selected.click();
            const ownVote = polls.getByRole("button", {
              name: /Cơ sở dữ liệu.*Phiếu của bạn/,
            });
            await ownVote.waitFor();
            assert.equal(await selected.getAttribute("aria-pressed"), "true");
            await pollPage.reload();
            await ownVote.waitFor();
            await polls.getByRole("button", { name: "Đóng bình chọn" }).click();
            await polls
              .getByText("Đã đóng · 1 phiếu", { exact: true })
              .waitFor();
            assert.ok(await selected.isDisabled());
          } finally {
            await pollPage.close();
            pollTest = false;
          }
        },
      );
      const page = await context.newPage();
      await page.goto(`${origin}/sessions/${sessionId}`);
      const panel = page.getByRole("region", { name: "Mic và camera" });
      await panel.waitFor();
      const unavailable = panel.getByText(
        "Phòng video chưa sẵn sàng. Vui lòng thử lại sau.",
        { exact: true },
      );
      await unavailable.waitFor();
      assert.equal(joins.length, 1);
      assert.equal(joins[0].participationId, participationId);
      assert.match(joins[0].clientId, /^[\da-f-]{36}$/);
      assert.equal(joins[0].userId, undefined);
      assert.equal(await panel.locator("video").count(), 0);
      await panel.getByText(listener.fullName, { exact: true }).waitFor();
      for (const name of ["Bật mic", "Bật camera"])
        assert.equal(
          await panel
            .getByRole("button", { name, exact: true })
            .getAttribute("aria-pressed"),
          "false",
        );
      await panel
        .getByRole("button", { name: "Kiểm tra thiết bị", exact: true })
        .click();
      await panel.locator("video").waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".class-media-room video")
            ?.srcObject?.getTracks().length === 2,
      );
      const tracks = await panel
        .locator("video")
        .evaluateHandle((video) => video.srcObject.getTracks());
      await panel.getByRole("button", { name: "Tắt mic", exact: true }).click();
      assert.equal(
        await panel
          .getByRole("button", { name: "Bật mic", exact: true })
          .getAttribute("aria-pressed"),
        "false",
      );
      await panel
        .getByRole("button", { name: "Ngắt thiết bị", exact: true })
        .click();
      assert.equal(
        await tracks.evaluate((items) =>
          items.every((track) => track.readyState === "ended"),
        ),
        true,
      );
      // A temporary preparation/revocation response should keep one intent
      // alive and retry automatically, without another click or token identity.
      joinFailures = ["MEDIA_STARTING", "MEDIA_REVOKING"];
      await panel
        .getByRole("button", { name: "Kết nối để nghe", exact: true })
        .click();
      await page.waitForResponse(
        (response) =>
          response.url().endsWith("/join") && response.status() === 503,
      );
      await panel
        .getByText("Phòng video chưa sẵn sàng. Vui lòng thử lại sau.", {
          exact: true,
        })
        .waitFor();
      assert.equal(joins.length, 4);
      assert.deepEqual(joins[1], joins[2]);
      assert.deepEqual(joins[2], joins[3]);
      // Stop while waiting must cancel the retry timer and stop all tracks.
      await panel
        .getByRole("button", { name: "Kiểm tra thiết bị", exact: true })
        .click();
      await panel.locator("video").waitFor({ timeout: 8000 }).catch(async () => {
        assert.fail(`Second device preview failed: ${await panel.innerText()}`);
      });
      joinFailures = Array(20).fill("MEDIA_STARTING");
      await panel
        .getByRole("button", { name: "Kết nối mic/camera", exact: true })
        .click();
      await page.waitForResponse(
        (response) =>
          response.url().endsWith("/join") && response.status() === 409,
      );
      // Leaving the participation stops media even while device controls are busy.
      await page
        .getByRole("button", { name: "Rời phòng", exact: true })
        .click();
      const stoppedCount = joins.length;
      await page.waitForTimeout(1600);
      assert.equal(joins.length, stoppedCount);
      assert.equal(await panel.locator("video").count(), 0);
      assert.equal(
        await panel
          .getByText(
            "Phòng video đang được chuẩn bị. Vui lòng thử lại sau vài giây.",
            { exact: true },
          )
          .count(),
        0,
      );
      // After an automatic connection fails, turning on the microphone can
      // reconnect the participant. A denied capture must leave it off.
      joinFailures = [];
      await page.reload();
      await unavailable.waitFor();
      await page.evaluate(() => {
        window.__getUserMedia = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        };
      });
      const beforeMicrophone = joins.length;
      await panel.getByRole("button", { name: "Bật mic", exact: true }).click();
      await panel.getByText(/Bạn chưa cho phép truy cập mic\/camera/).waitFor();
      assert.equal(joins.length, beforeMicrophone);
      assert.equal(await panel.locator("video").count(), 0);
      assert.equal(
        await panel
          .getByRole("button", { name: "Bật mic", exact: true })
          .getAttribute("aria-pressed"),
        "false",
      );
      await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = window.__getUserMedia;
      });
      joinFailures = Array(20).fill("MEDIA_STARTING");
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith("/join") && response.status() === 409,
        ),
        panel.getByRole("button", { name: "Bật mic", exact: true }).click(),
      ]);
      const microphoneTracks = await panel
        .locator("video")
        .evaluateHandle((video) => video.srcObject.getTracks());
      assert.deepEqual(
        await microphoneTracks.evaluate((tracks) =>
          tracks.map((track) => track.kind),
        ),
        ["audio"],
        "Enabling the microphone must not also turn on the camera",
      );
      assert.equal(
        await panel
          .getByRole("button", { name: "Tắt mic", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await page
        .getByRole("button", { name: "Rời phòng", exact: true })
        .click();
      const microphoneStoppedCount = joins.length;
      await page.waitForTimeout(1600);
      assert.equal(joins.length, microphoneStoppedCount);
      assert.ok(
        await microphoneTracks.evaluate((tracks) =>
          tracks.every((track) => track.readyState === "ended"),
        ),
      );
      // Persistent preparation has a bounded wait and gives the user control
      // again. Advance browser time instead of spending two real minutes.
      await page.clock.install();
      joinFailures = Array(100).fill("MEDIA_STARTING");
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith("/join") && response.status() === 409,
        ),
        page.reload(),
      ]);
      await page.clock.setSystemTime(
        new Date((await page.evaluate(() => Date.now())) + 131000),
      );
      await page.clock.runFor(1000);
      await panel
        .getByText(
          "Phòng video đang được chuẩn bị. Vui lòng thử lại sau vài giây.",
          { exact: true },
        )
        .waitFor();
      assert.ok(
        await panel
          .getByRole("button", { name: "Kết nối để nghe", exact: true })
          .isEnabled(),
      );
      mkdirSync(resolve(root, ".preview"), { recursive: true });
      await page.screenshot({
        path: resolve(root, ".preview/t05-room-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        true,
      );
      await page.screenshot({
        path: resolve(root, ".preview/t05-room-mobile.png"),
        fullPage: true,
      });
      await context.close();
    } finally {
      if (browser) await browser.close();
      if (process.platform === "win32" && web.pid && web.exitCode === null)
        await new Promise((resolve) =>
          execFile(
            "taskkill",
            ["/PID", String(web.pid), "/T", "/F"],
            { windowsHide: true },
            () => resolve(),
          ),
        );
      else web.kill();
    }
  },
);
