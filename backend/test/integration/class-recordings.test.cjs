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
  disconnected = [];
const mocked = ["ensureStage", "token", "disconnect", "presence", "close"];
before(
  async () => {
    for (const name of mocked) originals[name] = IvsService.prototype[name];
    originals.boot = ClassMediaWorker.prototype.onApplicationBootstrap;
    ClassMediaWorker.prototype.onApplicationBootstrap = function () {};
    IvsService.prototype.ensureStage = async (id) =>
      `arn:aws:ivs:ap-northeast-1:123456789012:stage/${id}`;
    IvsService.prototype.token = async () => ({
      token: "opaque-test-token-" + randomUUID(),
      participantId: randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    });
    IvsService.prototype.disconnect = async (_stage, participantId) => {
      disconnected.push(participantId);
    };
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
  for (const name of mocked) IvsService.prototype[name] = originals[name];
  ClassMediaWorker.prototype.onApplicationBootstrap = originals.boot;
});

async function enter(user, session) {
  // Lessons use APPROVAL admission: viewers ask first and the owner accepts.
  if ([f.viewer.id, f.viewer2.id].includes(user.id)) {
    const { request } = expect(
      await f.api(user, "POST", `/sessions/${session.id}/join-requests`, {}, { key: randomUUID() }),
      200,
    );
    expect(
      await f.api(f.owner, "PATCH", `/sessions/${session.id}/join-requests/${request.id}`, {
        decision: "ACCEPT",
      }),
      200,
    );
  }
  const result = expect(
    await f.api(user, "POST", `/sessions/${session.id}/enter`, {}, { key: randomUUID() }),
    200,
  );
  return result.participation.id;
}
async function share(user, session, participationId) {
  return f.api(user, "POST", `/sessions/${session.id}/join`, {
    participationId,
    clientId: randomUUID(),
    requestId: randomUUID(),
    source: "SCREEN",
  });
}
async function classroom() {
  const session = await f.lesson();
  const visits = {};
  for (const name of ["owner", "host", "viewer", "viewer2"])
    visits[name] = await enter(f[name], session);
  return { session, visits, root: `/sessions/${session.id}` };
}

test("recording keeps only the first screen share and blocks new ones until it stops", async () => {
  const { session, visits, root } = await classroom();
  const first = expect(await share(f.host, session, visits.host), 200);
  const second = expect(await share(f.viewer, session, visits.viewer), 200);

  expect(
    await f.api(f.viewer, "POST", `${root}/recordings`, { participationId: visits.viewer }),
    403,
  );
  const { recording } = expect(
    await f.api(f.owner, "POST", `${root}/recordings`, { participationId: visits.owner }),
    200,
  );
  assert.equal(recording.status, "RECORDING");
  assert.equal(recording.presenter.userId, f.host.id);
  assert.equal(recording.presenter.participantId, first.participantId);
  assert.ok(disconnected.includes(second.participantId));
  assert.ok(!disconnected.includes(first.participantId));
  const revoked = await f.prisma.classMediaConnection.findUnique({
    where: { id: second.connectionId },
  });
  assert.equal(revoked.state, "REVOKED");

  expect(await share(f.viewer, session, visits.viewer), 409, "SCREEN_SHARE_TAKEN");
  const retry = expect(
    await f.api(f.owner, "POST", `${root}/recordings`, { participationId: visits.owner }),
    200,
  );
  assert.equal(retry.recording.id, recording.id);
  // Another manager cannot start a second, parallel recording.
  expect(
    await f.api(f.host, "POST", `${root}/recordings`, { participationId: visits.host }),
    409,
    "RECORDING_ACTIVE",
  );

  // The presenter frees the slot; the next person to share becomes presenter.
  expect(
    await f.api(f.host, "POST", `${root}/media/${first.connectionId}/leave`, {
      requestId: first.requestId,
    }),
    200,
  );
  const next = expect(await share(f.viewer, session, visits.viewer), 200);
  const state = expect(await f.api(f.viewer2, "GET", `${root}/recording`), 200);
  assert.equal(state.recording.presenter.participantId, next.participantId);
  assert.equal(state.canRecord, false);

  expect(
    await f.api(f.owner, "POST", `${root}/recordings/${recording.id}/stop`, {}),
    200,
  );
  expect(await share(f.viewer2, session, visits.viewer2), 200);
});

test("only the presenter or a manager moves the camera; only the recorder saves the file", async () => {
  const { session, visits, root } = await classroom();
  expect(await share(f.viewer, session, visits.viewer), 200);
  const { recording } = expect(
    await f.api(f.owner, "POST", `${root}/recordings`, { participationId: visits.owner }),
    200,
  );
  const layout = `${root}/recordings/${recording.id}/layout`;
  expect(await f.api(f.viewer2, "PATCH", layout, { cameraVisible: false }), 403);
  expect(await f.api(f.viewer, "PATCH", layout, { cameraPosition: "middle" }), 400);
  const moved = expect(
    await f.api(f.viewer, "PATCH", layout, { cameraPosition: "top-left", cameraVisible: false }),
    200,
  );
  assert.deepEqual(moved.recording.layout, { cameraPosition: "top-left", cameraVisible: false });
  assert.ok(moved.recording.version > recording.version);
  expect(await f.api(f.host, "PATCH", layout, { cameraVisible: true }), 200);

  expect(await f.api(f.host, "POST", `${root}/recordings/${recording.id}/heartbeat`, {}), 403);
  expect(await f.api(f.owner, "POST", `${root}/recordings/${recording.id}/heartbeat`, {}), 200);

  const complete = `${root}/recordings/${recording.id}/complete`;
  const file = await f.prisma.libraryFile.create({
    data: {
      groupId: session.groupId,
      name: "Bản ghi.webm",
      size: 1024n,
      mimeType: "video/webm",
      source: "LOCAL_RECORDING",
      status: "AVAILABLE",
      objectKey: `test/recordings/${randomUUID()}.webm`,
      sessionId: session.id,
      createdBy: f.owner.id,
    },
  });
  const foreign = await f.prisma.libraryFile.create({
    data: {
      groupId: session.groupId,
      name: "Tài liệu.pdf",
      size: 10n,
      mimeType: "application/pdf",
      source: "DOCUMENT",
      status: "AVAILABLE",
      objectKey: `test/documents/${randomUUID()}.pdf`,
      createdBy: f.owner.id,
    },
  });
  expect(await f.api(f.owner, "POST", complete, { fileId: foreign.id }), 409, "RECORDING_FILE_INVALID");
  expect(await f.api(f.host, "POST", complete, { fileId: file.id }), 403);
  const saved = expect(await f.api(f.owner, "POST", complete, { fileId: file.id }), 200);
  assert.equal(saved.recording.status, "SAVED");
  assert.equal(saved.recording.fileId, file.id);
  expect(await f.api(f.owner, "POST", complete, { fileId: file.id }), 200);
  const state = expect(await f.api(f.viewer, "GET", `${root}/recording`), 200);
  assert.equal(state.recording, null);
  assert.equal(state.groupId, session.groupId);
});

test("an abandoned recording expires and stops blocking screen shares", async () => {
  const { session, visits, root } = await classroom();
  expect(await share(f.host, session, visits.host), 200);
  const { recording } = expect(
    await f.api(f.owner, "POST", `${root}/recordings`, { participationId: visits.owner }),
    200,
  );
  expect(await share(f.viewer, session, visits.viewer), 409, "SCREEN_SHARE_TAKEN");
  await f.prisma.classRecording.update({
    where: { id: recording.id },
    data: { lastSeenAt: new Date(Date.now() - 60000) },
  });
  expect(await share(f.viewer, session, visits.viewer), 200);
  const row = await f.prisma.classRecording.findUnique({ where: { id: recording.id } });
  assert.equal(row.status, "FAILED");
  const changes = await f.prisma.classSessionChange.count({
    where: { sessionId: session.id, kind: "recording.changed" },
  });
  assert.ok(changes >= 2);
  // A new recording can start once the old one expired.
  expect(
    await f.api(f.owner, "POST", `${root}/recordings`, { participationId: visits.owner }),
    200,
  );
});
