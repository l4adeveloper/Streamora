// Explicit opt-in: creates one temporary AWS Stage and connects two synthetic
// browser participants. Uses an isolated database and removes its own Stage.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, cp, mkdir, writeFile, rm } = require("node:fs/promises");
const { resolve, join, dirname } = require("node:path");
const { parseEnv, promisify } = require("node:util");
const { execFile, spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { chromium } = require("playwright");
const {
  IVSRealTimeClient,
  ListStagesCommand,
  GetStageCommand,
  ListCompositionsCommand,
  DeleteStageCommand,
} = require("@aws-sdk/client-ivs-realtime");
const { SQSClient, GetQueueAttributesCommand } = require("@aws-sdk/client-sqs");
const { readEnvironment } = require("../dist/config/environment");
const { PrismaService } = require("../dist/database/prisma.service");
const { createMeetingFixture } = require("../test/meeting-fixture.cjs");

const root = resolve(__dirname, "../..");
const output = join(root, ".preview", "ivs-live-review");
const directory = join(root, ".preview", `ivs-live-${randomUUID()}`);
const report = { startedAt: new Date().toISOString(), ok: false, checks: [] };
let secrets = [];
function safeError(error) {
  let message = String(error?.message ?? error);
  for (const secret of secrets)
    if (secret) message = message.split(secret).join("[redacted]");
  message = message.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-token]");
  return {
    name: error?.name,
    code: error?.code,
    message: message.slice(0, 1400),
  };
}
function result(name, details = {}) {
  const check = { name, ...details };
  report.checks.push(check);
  console.log(JSON.stringify(check));
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(name, check, timeout = 35000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(500);
  }
  throw new Error(`Timed out: ${name}`);
}
async function configuredDatabase(config) {
  const db = new PrismaService(config.databaseUrl);
  try {
    await db.onModuleInit();
    const columns = await db.$queryRawUnsafe(`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'class_sessions' AND column_name IN ('member_admission', 'allow_guests')) OR
        (table_name = 'groups' AND column_name = 'meeting_sequence') OR
        (table_name = 'group_chat_messages' AND column_name = 'meeting_id') OR
        (table_name = 'class_media_rooms' AND column_name = 'stage_arn')
      )`);
    const ready = columns[0]?.count === 5;
    result("configured-database", {
      ok: ready,
      connected: true,
      meetingSchemaReady: ready,
      readOnly: true,
    });
    return ready;
  } catch (error) {
    result("configured-database", {
      ok: false,
      ...safeError(error),
      readOnly: true,
    });
    return false;
  } finally {
    await db.$disconnect();
  }
}
async function liveCheck() {
  if (!process.argv.includes("--live")) {
    console.log(
      "Run npm run build --workspace=@streamora/api, then node backend/scripts/check-ivs.cjs --live (uses real AWS resources briefly).",
    );
    process.exitCode = 1;
    return;
  }
  const local = parseEnv(await readFile(join(root, "backend/.env"), "utf8"));
  const env = { ...local, ...process.env };
  secrets = [
    env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY,
    env.AWS_SESSION_TOKEN,
    env.DATABASE_URL,
    env.ACCESS_TOKEN_SECRET,
  ].filter(Boolean);
  const config = readEnvironment(env);
  assert.equal(config.ivs.enabled, true, "IVS_ENABLED must be true");
  await mkdir(output, { recursive: true });
  const awsOptions = {
    region: config.ivs.region,
    credentials: config.ivs.credentials,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 },
  };
  const control = new IVSRealTimeClient(awsOptions);
  const queue = new SQSClient(awsOptions);
  let f, browser, server, owner, room, stageArn;
  try {
    await control.send(new ListStagesCommand({ maxResults: 1 }));
    result("aws-ivs-access", { ok: true, region: config.ivs.region });
    if (config.ivs.eventsQueueUrl) {
      await queue.send(
        new GetQueueAttributesCommand({
          QueueUrl: config.ivs.eventsQueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      result("aws-sqs-access", { ok: true, consumedMessages: 0 });
    }
    const databaseReady = await configuredDatabase(config);
    const probe = createServer();
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    const origin = `http://127.0.0.1:${port}`;
    f = await createMeetingFixture(origin, { ivs: config.ivs });
    owner = await f.account("IVS smoke · Chủ phòng");
    const member = await f.account("IVS smoke · Thành viên");
    const password = randomUUID() + "Aa1!";
    const passwordHash = await require("argon2").hash(password);
    await f.prisma.user.updateMany({ data: { passwordHash } });
    const group = await f.prisma.group.create({
      data: {
        name: "Kiểm thử IVS trực tiếp",
        ownerId: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: member.id, role: "VIEWER" },
          ],
        },
      },
    });
    const created = await f.api(
      owner,
      "POST",
      `/groups/${group.id}/sessions`,
      { title: "Kiểm thử kết nối IVS" },
      randomUUID(),
    );
    assert.equal(created.status, 201, "Create meeting");
    room = created.body.session;
    assert.equal(
      (
        await f.api(
          owner,
          "POST",
          `/sessions/${room.id}/start`,
          {},
          randomUUID(),
        )
      ).status,
      200,
      "Start meeting",
    );
    result("isolated-meeting", {
      ok: true,
      usesApplicationDatabase: false,
      consumesEventQueue: false,
    });
    await mkdir(directory, { recursive: true });
    for (const name of ["src", "public"])
      await cp(join(root, "frontend", name), join(directory, name), {
        recursive: true,
      });
    for (const name of ["tsconfig.json", "package.json", "next-env.d.ts"])
      await cp(join(root, "frontend", name), join(directory, name));
    await writeFile(
      join(directory, "next.config.ts"),
      'import config from "../../frontend/next.config"; export default { ...config, experimental: { cpus: 1 } };',
    );
    const webEnv = {
      ...process.env,
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: f.base,
      NEXT_PUBLIC_REALTIME_URL: f.base.replace(/\/api\/v1$/, ""),
      NEXT_TELEMETRY_DISABLED: "1",
    };
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "DATABASE_URL",
      "ACCESS_TOKEN_SECRET",
    ])
      delete webEnv[name];
    const next = require.resolve("next/dist/bin/next");
    await promisify(execFile)(process.execPath, [next, "build"], {
      cwd: directory,
      env: webEnv,
      timeout: 150000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    result("production-frontend-build", { ok: true });
    server = spawn(
      process.execPath,
      [next, "start", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: directory, env: webEnv, stdio: "ignore", windowsHide: true },
    );
    await until("frontend startup", async () => {
      try {
        return (await fetch(origin)).ok;
      } catch {
        return false;
      }
    });
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === "win32" ? "msedge" : undefined,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const pageErrors = [],
      mediaResponses = [];
    async function login(actor) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await context.addInitScript(() => {
        window.__ivsConnections = [];
        const Original = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
          constructor(...args) {
            super(...args);
            window.__ivsConnections.push(this);
          }
        };
      });
      const page = await context.newPage();
      page.setDefaultTimeout(40000);
      page.on("pageerror", (error) => pageErrors.push(safeError(error)));
      page.on("response", (response) => {
        if (/\/sessions\/[^/]+\/join$/.test(new URL(response.url()).pathname))
          mediaResponses.push({ actor: actor.id, status: response.status() });
      });
      await page.goto(`${origin}/login`);
      await page.getByLabel("Email", { exact: true }).fill(actor.email);
      await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("**/workspace");
      await page.goto(`${origin}/meet/${room.joinCode}`);
      await page.waitForURL(
        `**/workspace?groupId=${group.id}&meetingId=${room.id}`,
      );
      await page.getByText("Bạn đang ở trong phòng", { exact: true }).waitFor();
      return page;
    }
    const first = await login(owner),
      second = await login(member);
    const mediaPanel = (page) =>
      page.getByRole("region", { name: "Mic và camera", exact: true });
    for (const page of [first, second]) {
      const panel = mediaPanel(page);
      await panel
        .getByRole("button", { name: "Kiểm tra thiết bị", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".class-media-room video")
            ?.srcObject?.getTracks().length === 2,
      );
    }
    await Promise.all(
      [first, second].map(async (page) => {
        const panel = mediaPanel(page);
        await panel
          .getByRole("button", { name: "Kết nối mic/camera", exact: true })
          .click();
        await panel
          .locator(".workspace-video-presence")
          .filter({ hasText: /đang kết nối video/ })
          .waitFor();
      }),
    );
    stageArn = (
      await f.prisma.classMediaRoom.findUnique({
        where: { sessionId: room.id },
      })
    )?.stageArn;
    assert.ok(stageArn, "AWS Stage must be persisted");
    assert.equal(
      mediaResponses.filter((item) => item.status === 200).length,
      2,
      "Both participants must receive real IVS credentials",
    );
    assert.equal(await f.prisma.classMediaRoom.count(), 1, "One shared Stage");
    for (const page of [first, second]) {
      await mediaPanel(page)
        .getByText("2 đang kết nối video", { exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const remote = document.querySelector(".workspace-media-feature video");
        return (
          remote &&
          !remote.muted &&
          remote.readyState >= 2 &&
          remote.videoWidth > 0 &&
          remote.srcObject?.getAudioTracks().length > 0 &&
          remote.srcObject?.getVideoTracks().length > 0
        );
      });
    }
    result("real-ivs-stage-and-tokens", {
      ok: true,
      stages: 1,
      connectedBrowsers: 2,
      simultaneousJoins: true,
      preparationRetries: mediaResponses.filter((item) => item.status === 409)
        .length,
      realAws: true,
    });
    async function statistics(page) {
      return page.evaluate(async () => {
        const inbound = [],
          outbound = [];
        for (const connection of window.__ivsConnections) {
          const stats = await connection.getStats();
          for (const entry of stats.values()) {
            const record = {
              kind: entry.kind ?? entry.mediaType,
              bytesReceived: entry.bytesReceived ?? 0,
              bytesSent: entry.bytesSent ?? 0,
              framesDecoded: entry.framesDecoded ?? 0,
              framesEncoded: entry.framesEncoded ?? 0,
              totalAudioEnergy: entry.totalAudioEnergy ?? 0,
              totalSamplesReceived: entry.totalSamplesReceived ?? 0,
            };
            if (entry.type === "inbound-rtp") inbound.push(record);
            if (entry.type === "outbound-rtp") outbound.push(record);
          }
        }
        return { inbound, outbound };
      });
    }
    const receivedBoth = (stats) =>
      stats.inbound.some(
        (item) =>
          item.kind === "video" &&
          item.framesDecoded >= 15 &&
          item.bytesReceived > 0,
      ) &&
      stats.inbound.some(
        (item) =>
          item.kind === "audio" &&
          item.bytesReceived > 0 &&
          item.totalSamplesReceived >= 48000 &&
          item.totalAudioEnergy > 0,
      );
    await until(
      "bidirectional audio and video",
      async () =>
        receivedBoth(await statistics(first)) &&
        receivedBoth(await statistics(second)),
    );
    const mediaStats = {
      owner: await statistics(first),
      member: await statistics(second),
    };
    result("bidirectional-audio-video", {
      ok: true,
      source: "browser RTC inbound/outbound statistics",
      ...mediaStats,
    });
    const heartbeatAfter = new Date();
    await pause(12000);
    const sustained = {
      owner: await statistics(first),
      member: await statistics(second),
    };
    for (const actor of ["owner", "member"]) {
      for (const kind of ["audio", "video"]) {
        const before = mediaStats[actor].inbound.find(
          (item) => item.kind === kind,
        );
        const after = sustained[actor].inbound.find(
          (item) => item.kind === kind,
        );
        assert.ok(
          after?.bytesReceived > before.bytesReceived,
          `${actor} must keep receiving ${kind}`,
        );
      }
    }
    await until("heartbeats and AWS presence reconciliation", async () => {
      const rows = await f.prisma.classMediaConnection.findMany({
        where: { sessionId: room.id },
      });
      return (
        rows.length === 2 &&
        rows.every(
          (row) =>
            row.state === "ACTIVE" &&
            row.connected &&
            row.lastSeenAt >= heartbeatAfter,
        )
      );
    });
    result("sustained-media-and-heartbeat", {
      ok: true,
      observedSeconds: 12,
      awsConfirmedParticipants: 2,
      ...sustained,
    });
    await first
      .getByRole("button", { name: "Chế độ tối", exact: true })
      .click();
    await first.screenshot({
      path: join(output, "two-participants.png"),
      fullPage: true,
      animations: "disabled",
    });
    await mediaPanel(first)
      .getByRole("button", { name: "Tắt camera", exact: true })
      .click();
    await second.locator(".workspace-media-feature video.camera-off").waitFor();
    await mediaPanel(first)
      .getByRole("button", { name: "Bật camera", exact: true })
      .click();
    await second
      .locator(".workspace-media-feature video:not(.camera-off)")
      .waitFor();
    await mediaPanel(first)
      .getByRole("button", { name: "Tắt mic", exact: true })
      .click();
    assert.equal(
      await mediaPanel(first)
        .getByRole("button", { name: "Bật mic", exact: true })
        .getAttribute("aria-pressed"),
      "false",
    );
    await mediaPanel(first)
      .getByRole("button", { name: "Bật mic", exact: true })
      .click();
    result("device-toggles", { ok: true, remoteCameraState: true });
    const localTracks = await second
      .locator(".workspace-media-local video")
      .evaluateHandle((video) => video.srcObject.getTracks());
    await second
      .getByRole("button", { name: "Rời phòng", exact: true })
      .click();
    await until(
      "member left",
      async () =>
        (await f.prisma.classParticipation.count({
          where: { sessionId: room.id, userId: member.id, leftAt: null },
        })) === 0,
    );
    assert.ok(
      await localTracks.evaluate((tracks) =>
        tracks.every((track) => track.readyState === "ended"),
      ),
      "Leave must stop local tracks",
    );
    await first.getByText("1 đang kết nối video", { exact: true }).waitFor();
    await until(
      "server media revocation",
      async () =>
        (
          await f.prisma.classMediaConnection.findFirst({
            where: { sessionId: room.id, userId: member.id },
          })
        )?.state === "REVOKED",
    );
    result("leave-and-revoke", {
      ok: true,
      localTracksEnded: true,
      serverConnectionRevoked: true,
    });
    assert.equal(
      (await f.api(owner, "POST", `/sessions/${room.id}/end`, {}, randomUUID()))
        .status,
      200,
    );
    await until(
      "end closes Stage",
      async () =>
        (
          await f.prisma.classMediaRoom.findUnique({
            where: { sessionId: room.id },
          })
        )?.state === "CLOSED",
    );
    result("meeting-end-closes-stage", { ok: true });
    assert.deepEqual(pageErrors, [], "No browser runtime errors");
    report.ok = databaseReady;
  } finally {
    if (browser) await browser.close();
    if (f && room) {
      stageArn ??= (
        await f.prisma.classMediaRoom.findUnique({
          where: { sessionId: room.id },
        })
      )?.stageArn;
      try {
        await f.api(
          owner,
          "POST",
          `/sessions/${room.id}/end`,
          {},
          randomUUID(),
        );
      } catch {}
      if (!stageArn) {
        const page = await control.send(
          new ListStagesCommand({ maxResults: 100 }),
        );
        stageArn = page.stages?.find(
          (stage) => stage.name === `streamora-test-${room.id}`,
        )?.arn;
      }
      if (stageArn) {
        try {
          const current = await control.send(
            new GetStageCommand({ arn: stageArn }),
          );
          assert.equal(
            current.stage?.tags?.streamoraSessionId,
            room.id,
            "Only clean up this test's tagged Stage",
          );
          const compositions = await control.send(
            new ListCompositionsCommand({
              filterByStageArn: stageArn,
              maxResults: 100,
            }),
          );
          assert.ok(
            !compositions.compositions?.some(
              (item) => !["STOPPED", "FAILED"].includes(item.state),
            ),
            "Do not interrupt a composition",
          );
          await control.send(new DeleteStageCommand({ arn: stageArn }));
          result("aws-stage-cleanup", {
            ok: true,
            deletedOwnedTestStage: true,
          });
        } catch (error) {
          if (error.name === "ResourceNotFoundException")
            result("aws-stage-cleanup", { ok: true, alreadyDeleted: true });
          else {
            report.ok = false;
            result("aws-stage-cleanup", {
              ok: false,
              stageArn,
              ...safeError(error),
            });
          }
        }
      }
    }
    if (server) {
      const exited = new Promise((done) => server.once("exit", done));
      server.kill();
      await exited;
    }
    if (f) await f.cleanup();
    control.destroy();
    queue.destroy();
    assert.equal(dirname(directory), join(root, ".preview"));
    assert.match(directory, /ivs-live-[a-f0-9-]{36}$/);
    await rm(directory, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  assert.ok(
    report.ok,
    "IVS checks completed; inspect any failed configured-environment checks in the report",
  );
}
liveCheck().catch(async (error) => {
  report.ok = false;
  result("live-check-failed", { ok: false, ...safeError(error) });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  process.exitCode = 1;
});
