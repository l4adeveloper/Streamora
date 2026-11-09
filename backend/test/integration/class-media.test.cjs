const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const {
  createClassSessionApiFixture,
  expect,
} = require("./class-session-api-fixture.cjs");
const { IvsService } = require("../../dist/modules/class-media/ivs.service");
const {
  ClassMediaWorker,
} = require("../../dist/modules/class-media/class-media.worker");
let f;
const originals = {},
  calls = [];
before(
  async () => {
    for (const name of [
      "ensureStage",
      "token",
      "disconnect",
      "presence",
      "close",
    ])
      originals[name] = IvsService.prototype[name];
    originals.boot = ClassMediaWorker.prototype.onApplicationBootstrap;
    ClassMediaWorker.prototype.onApplicationBootstrap = function () {};
    IvsService.prototype.ensureStage = async (id) =>
      `arn:aws:ivs:ap-northeast-1:123456789012:stage/${id}`;
    IvsService.prototype.token = async function (_stage, userId) {
      calls.push(userId);
      return {
        token: "opaque-test-token-" + randomUUID(),
        participantId: randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
      };
    };
    IvsService.prototype.disconnect = async () => {};
    IvsService.prototype.presence = async () => ({
      sessionId: "stage-session",
      connectedIds: new Set(),
    });
    IvsService.prototype.close = async () => true;
    f = await createClassSessionApiFixture({
      ivs: {
        enabled: true,
        region: "ap-northeast-1",
        tokenTtlSeconds: 60,
        workerEnabled: false,
        eventsQueueUrl: "",
      },
    });
  },
  { timeout: 120000 },
);
after(async () => {
  if (f) await f.cleanup();
  for (const name of [
    "ensureStage",
    "token",
    "disconnect",
    "presence",
    "close",
  ])
    IvsService.prototype[name] = originals[name];
  ClassMediaWorker.prototype.onApplicationBootstrap = originals.boot;
});
async function entered() {
  const session = await f.lesson();
  const result = expect(
    await f.api(
      f.owner,
      "POST",
      `/sessions/${session.id}/enter`,
      {},
      randomUUID(),
    ),
    200,
  );
  return {
    session,
    visit: result.participation,
    body: {
      participationId: result.participation.id,
      clientId: randomUUID(),
      requestId: randomUUID(),
    },
  };
}
test("T05 actual entry is required and request identities cannot override Bearer", async () => {
  const { session, body } = await entered();
  const path = `/sessions/${session.id}/join`;
  expect(await f.api(null, "POST", path, body), 401);
  expect(await f.api(f.viewer, "POST", path, body), 403);
  expect(
    await f.api(f.owner, "POST", path, { ...body, userId: f.admin.id }),
    400,
  );
  const joined = expect(await f.api(f.owner, "POST", path, body), 200);
  assert.equal(calls.at(-1), f.owner.id);
  assert.match(joined.participantToken, /^opaque-test-token/);
});
test("T05 retries across instances return one participant and preserve encrypted token storage", async () => {
  const { session, body } = await entered();
  const first = expect(
    await f.api(f.owner, "POST", `/sessions/${session.id}/join`, body),
    200,
  );
  const retry = expect(
    await f.api(
      f.owner,
      "POST",
      `/sessions/${session.id}/join`,
      body,
      undefined,
      f.otherBase,
    ),
    200,
  );
  assert.equal(first.participantId, retry.participantId);
  assert.equal(first.participantToken, retry.participantToken);
  const rows = await f.prisma.classMediaConnection.findMany({
    where: { participationId: body.participationId },
  });
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(first.participantToken));
});
test("T05 ban blocks issuance and existing connections are revoked by the worker", async () => {
  const { session, body } = await entered();
  expect(
    await f.api(f.owner, "POST", `/sessions/${session.id}/join`, body),
    200,
  );
  await f.prisma.sessionBan.create({
    data: { sessionId: session.id, userId: f.owner.id },
  });
  expect(
    await f.api(f.owner, "POST", `/sessions/${session.id}/join`, body),
    403,
    "BANNED",
  );
  await f.app.get(ClassMediaWorker).tick();
  assert.equal(
    (
      await f.prisma.classMediaConnection.findFirst({
        where: { participationId: body.participationId },
      })
    ).state,
    "REVOKED",
  );
});
test("T05 closing T04 participation denies renewal and revokes the media connection", async () => {
  const { session, visit, body } = await entered();
  const media = expect(
    await f.api(f.owner, "POST", `/sessions/${session.id}/join`, body),
    200,
  );
  expect(
    await f.api(
      f.owner,
      "POST",
      `/sessions/${session.id}/participations/${visit.id}/leave`,
      {},
    ),
    200,
  );
  expect(
    await f.api(
      f.owner,
      "POST",
      `/sessions/${session.id}/media/${media.connectionId}/heartbeat`,
      {
        participationId: visit.id,
        requestId: media.requestId,
        clientId: body.clientId,
        connected: true,
        micEnabled: true,
        cameraEnabled: true,
      },
    ),
    403,
  );
  await f.app.get(ClassMediaWorker).tick();
  assert.equal(
    (
      await f.prisma.classMediaConnection.findUnique({
        where: { id: media.connectionId },
      })
    ).state,
    "REVOKED",
  );
});
