const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn, execFile } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { mkdirSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");

test(
  "T05 browser previews devices, releases tracks, handles missing IVS and fits mobile",
  { timeout: 120000 },
  async () => {
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
      const joins = [];
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
          "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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
            ],
            nextCursor: null,
          };
        else if (path === `/api/v1/sessions/${sessionId}`) body = { session };
        else if (path.endsWith("/join")) {
          joins.push(request.postDataJSON());
          return route.fulfill({
            status: 503,
            headers,
            body: JSON.stringify({
              error: { code: "MEDIA_UNAVAILABLE", message: "Unavailable" },
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
      const page = await context.newPage();
      await page.goto(`${origin}/sessions/${sessionId}`);
      const panel = page.getByRole("region", { name: "Mic và camera" });
      await panel.waitFor();
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
      await panel
        .getByRole("button", { name: "Kết nối để nghe", exact: true })
        .click();
      await panel
        .getByText("Phòng video chưa sẵn sàng. Vui lòng thử lại sau.", {
          exact: true,
        })
        .waitFor();
      assert.equal(joins.length, 1);
      assert.equal(joins[0].participationId, participationId);
      assert.match(joins[0].clientId, /^[\da-f-]{36}$/);
      assert.equal(joins[0].userId, undefined);
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
