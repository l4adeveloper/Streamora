const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMeetingFixture } = require("../meeting-fixture.cjs");
const { IvsService } = require("../../dist/modules/class-media/ivs.service");
const {
  ClassMediaWorker,
} = require("../../dist/modules/class-media/class-media.worker");
const {
  ClassPresenceService,
} = require("../../dist/modules/class-sessions/class-presence.service");
const {
  ClassSessionsService,
} = require("../../dist/modules/class-sessions/class-sessions.service");
const {
  ClassSessionAutoCloseService,
} = require("../../dist/modules/class-sessions/class-session-auto-close.service");
let f, db, user, group, presence, worker, sessions, autoClose;
const connectedIds = new Set(),
  disconnectedIds = [];
before(
  async () => {
    f = await createMeetingFixture();
    db = f.prisma;
    user = await f.account("Host");
    group = await db.group.create({
      data: { name: "Presence and end", ownerId: user.id },
    });
    const ivs = f.app.get(IvsService);
    ivs.presence = async () => ({ sessionId: "stage-session", connectedIds });
    ivs.disconnect = async (_stage, id) => {
      disconnectedIds.push(id);
      connectedIds.delete(id);
    };
    ivs.close = async () => true;
    worker = f.app.get(ClassMediaWorker);
    presence = f.app.get(ClassPresenceService);
    sessions = f.app.get(ClassSessionsService);
    autoClose = f.app.get(ClassSessionAutoCloseService);
  },
  { timeout: 120000 },
);
after(async () => {
  if (f) await f.cleanup();
});
async function entered(source = "CAMERA") {
  const lesson = await db.classSession.create({
    data: {
      kind: "GROUP",
      groupId: group.id,
      createdById: user.id,
      title: "Keep alive",
      joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
      status: "LIVE",
      scheduledAt: new Date(),
      startedAt: new Date(),
    },
  });
  const past = new Date(Date.now() - 120000);
  const visit = await db.classParticipation.create({
    data: {
      sessionId: lesson.id,
      userId: user.id,
      joinedAt: past,
      lastSeenAt: past,
    },
  });
  const auth = await db.authSession.findFirstOrThrow({
    where: { userId: user.id },
  });
  await db.classMediaRoom.create({
    data: {
      sessionId: lesson.id,
      state: "READY",
      stageArn: `arn:aws:ivs:ap-northeast-1:123456789012:stage/${lesson.id}`,
      checkedAt: new Date(Date.now() + 3600000),
    },
  });
  const media = await db.classMediaConnection.create({
    data: {
      sessionId: lesson.id,
      participationId: visit.id,
      userId: user.id,
      authSessionId: auth.id,
      clientId: randomUUID(),
      requestId: randomUUID(),
      participantId: randomUUID(),
      source,
      state: "ACTIVE",
      connected: true,
      lastSeenAt: past,
      presenceVerifiedAt: new Date(),
    },
  });
  connectedIds.add(media.participantId);
  return { lesson, visit, media, auth };
}

test("camera OR screen presence keeps a background tab admitted after browser heartbeats stop", async () => {
  for (const source of ["CAMERA", "SCREEN"]) {
    const { lesson, visit, media } = await entered(source);
    await presence.sweep();
    assert.equal(
      (
        await db.classParticipation.findUniqueOrThrow({
          where: { id: visit.id },
        })
      ).leftAt,
      null,
    );
    assert.equal(await autoClose.countActiveParticipants(lesson.id), 1);
    const admission = await f.api(
      user,
      "GET",
      `/sessions/${lesson.id}/admission`,
    );
    assert.equal(admission.status, 200);
    assert.equal(admission.body.participation.id, visit.id);
    await db.classMediaConnection.update({
      where: { id: media.id },
      data: { presenceVerifiedAt: new Date(0) },
    });
    await worker.tick();
    const kept = await db.classMediaConnection.findUniqueOrThrow({
      where: { id: media.id },
    });
    assert.equal(kept.state, "ACTIVE");
    assert.ok(kept.presenceVerifiedAt.getTime() > Date.now() - 10000);
    assert.ok(!disconnectedIds.includes(media.participantId));
  }
});

test("an actually disconnected participant expires; an actual ban still revokes a connected screen", async () => {
  const offline = await entered();
  connectedIds.delete(offline.media.participantId);
  await db.classMediaConnection.update({
    where: { id: offline.media.id },
    data: { presenceVerifiedAt: new Date(0) },
  });
  await worker.tick();
  await presence.sweep();
  assert.equal(
    (
      await db.classParticipation.findUniqueOrThrow({
        where: { id: offline.visit.id },
      })
    ).leaveReason,
    "DISCONNECTED",
  );
  const banned = await entered("SCREEN");
  await db.sessionBan.create({
    data: { sessionId: banned.lesson.id, userId: user.id },
  });
  await worker.tick();
  assert.equal(
    (
      await db.classMediaConnection.findUniqueOrThrow({
        where: { id: banned.media.id },
      })
    ).state,
    "REVOKED",
  );
  assert.ok(disconnectedIds.includes(banned.media.participantId));
});

test("End waits for every saving recording and survives reconnects; a failed save keeps the meeting open", async () => {
  const { lesson, visit } = await entered();
  const rec = await db.classRecording.create({
    data: {
      id: randomUUID(),
      sessionId: lesson.id,
      recorderId: user.id,
      provider: "IVS",
    },
  });
  const ended = await f.api(
    user,
    "POST",
    `/sessions/${lesson.id}/end`,
    {},
    randomUUID(),
  );
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.session.status, "LIVE");
  assert.ok(ended.body.session.endRequestedAt);
  assert.equal(
    (await db.classRecording.findUniqueOrThrow({ where: { id: rec.id } }))
      .status,
    "SAVING",
  );
  await autoClose.checkSession(lesson.id);
  assert.equal(
    (await db.classParticipation.findUniqueOrThrow({ where: { id: visit.id } }))
      .leftAt,
    null,
  );
  await db.classRecording.update({
    where: { id: rec.id },
    data: { status: "FAILED", stoppedAt: new Date(Date.now() + 1000) },
  });
  await autoClose.checkSession(lesson.id);
  assert.equal(
    (await db.classSession.findUniqueOrThrow({ where: { id: lesson.id } }))
      .status,
    "LIVE",
  );
  const file = await db.libraryFile.create({
    data: {
      groupId: group.id,
      sessionId: lesson.id,
      createdBy: user.id,
      name: "Saved.mp4",
      objectKey: `saved/${randomUUID()}.mp4`,
      size: 100n,
      mimeType: "video/mp4",
      source: "CLOUD_RECORDING",
      status: "AVAILABLE",
    },
  });
  await db.classRecording.update({
    where: { id: rec.id },
    data: { status: "SAVED", fileId: file.id },
  });
  await autoClose.checkSession(lesson.id);
  assert.equal(
    (await db.classSession.findUniqueOrThrow({ where: { id: lesson.id } }))
      .status,
    "ENDED",
  );
  assert.equal(
    await db.classSessionEndEvent.count({ where: { sessionId: lesson.id } }),
    1,
  );
  await sessions.finishRequestedEnd(lesson.id);
  assert.equal(
    await db.classSessionEndEvent.count({ where: { sessionId: lesson.id } }),
    1,
  );
});
