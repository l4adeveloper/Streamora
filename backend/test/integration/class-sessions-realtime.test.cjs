const assert = require("node:assert/strict");
const { test, before, after, afterEach } = require("node:test");
const { randomUUID } = require("node:crypto");
const { io } = require("socket.io-client");
const {
  createClassSessionApiFixture,
  expect,
} = require("./class-session-api-fixture.cjs");
const {
  ClassPresenceService,
} = require("../../dist/modules/class-sessions/class-presence.service");
const {
  ClassSessionsGateway,
} = require("../../dist/modules/class-sessions/class-sessions.gateway");
const {
  AccessTokenService,
} = require("../../dist/modules/auth/access-token.service");

let f;
const sockets = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(work, message = "condition did not become true") {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const value = await work();
    if (value) return value;
    await pause(40);
  }
  assert.fail(message);
}
before(
  async () => {
    f = await createClassSessionApiFixture({
      sessionRealtime: {
        pollIntervalMs: 60,
        sweepIntervalMs: 120,
        heartbeatIntervalMs: 400,
        leaseTtlMs: 2400,
      },
    });
  },
  { timeout: 120000 },
);
afterEach(() => {
  for (const socket of sockets) socket.disconnect();
  sockets.clear();
});
after(async () => {
  if (f) await f.cleanup();
});

async function socket(
  actor,
  target = f.otherBase,
  origin = "http://127.0.0.1:3000",
) {
  const client = io(`${target}/sessions`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    auth: { accessToken: actor?.token },
    extraHeaders: origin ? { Origin: origin } : {},
  });
  sockets.add(client);
  client.events = [];
  client.onAny((name, data) => client.events.push({ name, data }));
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
  return client;
}
const ack = (client, event, data) =>
  client.timeout(5000).emitWithAck(event, data);
async function ok(client, event, data) {
  const result = await ack(client, event, data);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
async function watch(client, session) {
  return ok(client, "session:watch", { sessionId: session.id });
}
const body = (session, visit) => ({
  sessionId: session.id,
  participationId: visit.id,
});
async function enter(session, actor = f.viewer) {
  if (actor.id !== f.owner.id) {
    const request = expect(
      await f.api(
        actor,
        "POST",
        `/sessions/${session.id}/join-requests`,
        {},
        { key: randomUUID() },
      ),
      200,
    ).request;
    expect(
      await f.api(
        f.owner,
        "PATCH",
        `/sessions/${session.id}/join-requests/${request.id}`,
        { decision: "ACCEPT" },
      ),
      200,
    );
  }
  return expect(
    await f.api(
      actor,
      "POST",
      `/sessions/${session.id}/enter`,
      {},
      { key: randomUUID() },
    ),
    200,
  ).participation;
}
const changed = (client, kind, id) =>
  client.events.find(
    (event) => event.name === kind && event.data.sessionId === id,
  );

test("T04 socket authentication rejects invalid tokens and foreign origins; watch snapshots contain only own admission", async () => {
  await assert.rejects(socket(null), /UNAUTHENTICATED/);
  await assert.rejects(socket({ token: "invalid" }), /UNAUTHENTICATED/);
  await assert.rejects(
    socket(f.viewer, f.base, "https://untrusted.example"),
    /UNAUTHENTICATED/,
  );
  const session = await f.lesson();
  const client = await socket(f.viewer);
  const snapshot = await watch(client, session);
  assert.equal(snapshot.sessionId, session.id);
  assert.equal(snapshot.admission.permissions.canManage, false);
  assert.equal(snapshot.reconnectGraceMs, 2400);
  assert.match(snapshot.version, /^\d+$/);
  assert.equal(JSON.stringify(snapshot).includes("email"), false);
  const invalid = await ack(client, "session:watch", {
    sessionId: session.id,
    userId: f.owner.id,
  });
  assert.equal(invalid.error.code, "VALIDATION_ERROR");
  const outsider = await socket(f.outsider);
  assert.equal(
    (await ack(outsider, "session:watch", { sessionId: session.id })).ok,
    false,
  );
});

test("T04 committed queue/admission changes reach other instances with recipient-specific privacy and replay safety", async () => {
  const session = await f.lesson();
  const manager = await socket(f.owner),
    viewer = await socket(f.viewer),
    other = await socket(f.viewer2);
  await Promise.all([
    watch(manager, session),
    watch(viewer, session),
    watch(other, session),
  ]);
  const key = randomUUID();
  const request = expect(
    await f.api(
      f.viewer,
      "POST",
      `/sessions/${session.id}/join-requests`,
      {},
      { key },
    ),
    200,
  ).request;
  await until(
    () =>
      changed(manager, "queue.changed", session.id) &&
      changed(viewer, "admission.changed", session.id),
  );
  const event = changed(viewer, "admission.changed", session.id).data;
  assert.deepEqual(Object.keys(event).sort(), [
    "eventId",
    "sessionId",
    "version",
  ]);
  assert.equal(changed(other, "admission.changed", session.id), undefined);
  assert.equal(changed(viewer, "queue.changed", session.id), undefined);
  const before = await f.prisma.classSessionChange.count({
    where: { sessionId: session.id },
  });
  expect(
    await f.api(
      f.viewer,
      "POST",
      `/sessions/${session.id}/join-requests`,
      {},
      { key },
    ),
    200,
  );
  assert.equal(
    await f.prisma.classSessionChange.count({
      where: { sessionId: session.id },
    }),
    before,
  );
  expect(
    await f.api(
      f.owner,
      "PATCH",
      `/sessions/${session.id}/join-requests/${request.id}`,
      { decision: "ACCEPT" },
    ),
    200,
  );
  await until(
    () =>
      viewer.events.filter(
        (e) =>
          e.name === "admission.changed" &&
          BigInt(e.data.version) > BigInt(event.version),
      ).length,
  );
  assert.equal(
    (await watch(viewer, session)).admission.permissions.canEnter,
    true,
  );
  assert.equal(
    await f.prisma.classParticipation.count({
      where: { sessionId: session.id },
    }),
    0,
  );
});

test("T04 sockets cannot enter, forge another visit, or heartbeat before attaching", async () => {
  const session = await f.lesson();
  const visit = await enter(session);
  const viewer = await socket(f.viewer),
    other = await socket(f.viewer2);
  await Promise.all([watch(viewer, session), watch(other, session)]);
  assert.equal(
    (await ack(viewer, "participation:heartbeat", body(session, visit))).error
      .code,
    "PRESENCE_NOT_ATTACHED",
  );
  assert.equal(
    (await ack(other, "participation:attach", body(session, visit))).error.code,
    "PARTICIPATION_NOT_FOUND",
  );
  assert.equal(
    (
      await ack(viewer, "participation:attach", {
        ...body(session, visit),
        userId: f.owner.id,
      })
    ).error.code,
    "VALIDATION_ERROR",
  );
  const receipt = await ok(
    viewer,
    "participation:attach",
    body(session, visit),
  );
  assert.equal(receipt.participationId, visit.id);
  assert.ok(new Date(receipt.expiresAt) > new Date(receipt.serverTime));
  await ok(viewer, "participation:heartbeat", body(session, visit));
  assert.equal(
    await f.prisma.classParticipation.count({
      where: { sessionId: session.id, leftAt: null },
    }),
    1,
  );
});

test("T04 multiple tabs across instances share one visit; losing one tab does not close the other", async () => {
  const session = await f.lesson(),
    visit = await enter(session);
  const first = await socket(f.viewer, f.base),
    second = await socket(f.viewer);
  await Promise.all([watch(first, session), watch(second, session)]);
  await Promise.all([
    ok(first, "participation:attach", body(session, visit)),
    ok(second, "participation:attach", body(session, visit)),
  ]);
  assert.equal(
    await f.prisma.classPresenceLease.count({
      where: { participationId: visit.id },
    }),
    2,
  );
  first.disconnect();
  await until(async () =>
    (
      await f.prisma.classPresenceLease.findMany({
        where: { participationId: visit.id },
      })
    ).some((lease) => !lease.connected),
  );
  for (let i = 0; i < 7; i++) {
    await pause(400);
    await ok(second, "participation:heartbeat", body(session, visit));
  }
  assert.equal(
    (await f.prisma.classParticipation.findUnique({ where: { id: visit.id } }))
      .leftAt,
    null,
  );
  const people = expect(
    await f.api(f.owner, "GET", `/sessions/${session.id}/participants`),
    200,
  ).items;
  assert.equal(
    people.filter((person) => person.userId === f.viewer.id).length,
    1,
  );
});

test("T04 reconnect/unwatch within grace reattaches the same visit and later expires it without auto-entry", async () => {
  const session = await f.lesson(),
    visit = await enter(session);
  const first = await socket(f.viewer);
  await watch(first, session);
  await ok(first, "participation:attach", body(session, visit));
  first.disconnect();
  await pause(150);
  const reconnect = await socket(f.viewer, f.base);
  assert.equal(
    (await watch(reconnect, session)).admission.participation.id,
    visit.id,
  );
  await ok(reconnect, "participation:attach", body(session, visit));
  await ok(reconnect, "session:unwatch", { sessionId: session.id });
  const ended = await until(async () => {
    const row = await f.prisma.classParticipation.findUnique({
      where: { id: visit.id },
    });
    return row.leftAt && row;
  });
  assert.equal(ended.leaveReason, "DISCONNECTED");
  assert.equal(
    await f.prisma.classPresenceLease.count({
      where: { participationId: visit.id },
    }),
    0,
  );
  const state = await watch(reconnect, session);
  assert.equal(state.admission.permissions.canEnter, false);
  assert.equal(state.admission.permissions.canRequestJoin, true);
  assert.equal(
    (await ack(reconnect, "participation:attach", body(session, visit))).error
      .code,
    "ADMISSION_REVOKED",
  );
});

test("T04 connected sockets without heartbeat expire; late heartbeats cannot revive admission", async () => {
  const session = await f.lesson(),
    visit = await enter(session);
  const client = await socket(f.viewer);
  await watch(client, session);
  await ok(client, "participation:attach", body(session, visit));
  await until(() => changed(client, "participation.closed", session.id));
  assert.equal(
    changed(client, "participation.closed", session.id).data.reason,
    "DISCONNECTED",
  );
  assert.equal(
    (await ack(client, "participation:heartbeat", body(session, visit))).ok,
    false,
  );
  assert.equal(
    (await ack(client, "participation:attach", body(session, visit))).error
      .code,
    "ADMISSION_REVOKED",
  );
  assert.equal(
    (
      await f.prisma.classJoinRequest.findUnique({
        where: { id: visit.joinRequestId },
      })
    ).status,
    "EXPIRED",
  );
});

test("T04 explicit leave closes every tab immediately and cannot close a newer visit", async () => {
  const session = await f.lesson(),
    visit = await enter(session);
  const first = await socket(f.viewer),
    second = await socket(f.viewer, f.base);
  await Promise.all([watch(first, session), watch(second, session)]);
  await Promise.all([
    ok(first, "participation:attach", body(session, visit)),
    ok(second, "participation:attach", body(session, visit)),
  ]);
  expect(
    await f.api(
      f.viewer,
      "POST",
      `/sessions/${session.id}/participations/${visit.id}/leave`,
      {},
    ),
    200,
  );
  const next = await enter(session);
  await until(
    () =>
      changed(first, "participation.closed", session.id) &&
      changed(second, "participation.closed", session.id),
  );
  assert.equal(
    changed(first, "participation.closed", session.id).data.reason,
    "LEFT",
  );
  expect(
    await f.api(
      f.viewer,
      "POST",
      `/sessions/${session.id}/participations/${visit.id}/leave`,
      {},
    ),
    200,
  );
  assert.equal(
    (await f.prisma.classParticipation.findUnique({ where: { id: next.id } }))
      .leftAt,
    null,
  );
});

test("T04 ending a session broadcasts once per committed change and closes live presence across instances", async () => {
  const session = await f.lesson(),
    visit = await enter(session);
  const client = await socket(f.viewer),
    owner = await socket(f.owner, f.base);
  await Promise.all([watch(client, session), watch(owner, session)]);
  await ok(client, "participation:attach", body(session, visit));
  const key = randomUUID();
  expect(
    await f.api(f.owner, "POST", `/sessions/${session.id}/end`, {}, { key }),
    200,
  );
  expect(
    await f.api(f.owner, "POST", `/sessions/${session.id}/end`, {}, { key }),
    200,
  );
  await until(
    () =>
      changed(client, "session.ended", session.id) &&
      changed(client, "participation.closed", session.id),
  );
  assert.equal(
    changed(client, "participation.closed", session.id).data.reason,
    "SESSION_ENDED",
  );
  assert.equal(
    await f.prisma.classSessionChange.count({
      where: { sessionId: session.id, kind: "session.ended" },
    }),
    1,
  );
  assert.equal(
    await f.prisma.classPresenceLease.count({
      where: { participationId: visit.id },
    }),
    0,
  );
});

test("T04 current membership gates delivery after role downgrade and removal", async () => {
  const session = await f.lesson();
  const host = await socket(f.host);
  await watch(host, session);
  expect(
    await f.api(
      f.owner,
      "PATCH",
      `/groups/${session.groupId}/members/${f.host.id}`,
      { role: "VIEWER" },
    ),
    200,
  );
  await until(() => changed(host, "access.changed", session.id));
  host.events.length = 0;
  expect(
    await f.api(
      f.viewer,
      "POST",
      `/sessions/${session.id}/join-requests`,
      {},
      { key: randomUUID() },
    ),
    200,
  );
  await pause(250);
  assert.equal(changed(host, "queue.changed", session.id), undefined);
  expect(
    await f.api(
      f.owner,
      "DELETE",
      `/groups/${session.groupId}/members/${f.host.id}`,
    ),
    204,
  );
  await until(() => changed(host, "session.access-revoked", session.id));
  assert.equal(
    (await ack(host, "session:watch", { sessionId: session.id })).ok,
    false,
  );
});

test("T04 logout only revokes its own connection leases; another login can keep the same visit alive", async () => {
  const session = await f.lesson();
  const login1 = await f.issue(f.viewer),
    login2 = await f.issue(f.viewer);
  const visit = await enter(session, login1);
  const first = await socket(login1),
    second = await socket(login2, f.base);
  await Promise.all([watch(first, session), watch(second, session)]);
  await Promise.all([
    ok(first, "participation:attach", body(session, visit)),
    ok(second, "participation:attach", body(session, visit)),
  ]);
  await f.prisma.authSession.update({
    where: { id: login1.authSessionId },
    data: { revokedAt: new Date(), revocationReason: "LOGOUT" },
  });
  await until(() => !first.connected);
  await ok(second, "participation:heartbeat", body(session, visit));
  assert.equal(
    (await f.prisma.classParticipation.findUnique({ where: { id: visit.id } }))
      .leftAt,
    null,
  );
  await f.prisma.authSession.update({
    where: { id: login2.authSessionId },
    data: { revokedAt: new Date(), revocationReason: "LOGOUT" },
  });
  const closed = await until(async () => {
    const row = await f.prisma.classParticipation.findUnique({
      where: { id: visit.id },
    });
    return row.leftAt && row;
  });
  assert.equal(closed.leaveReason, "ACCESS_REVOKED");
});

test("T04 auth refresh accepts only the same user and login session", async () => {
  const login = await f.issue(f.viewer);
  const client = await socket(login);
  const refreshed = f.app
    .get(AccessTokenService)
    .issue(login.id, login.authSessionId, 900, new Date());
  await ok(client, "auth:refresh", { accessToken: refreshed });
  const another = await f.issue(f.viewer);
  const result = await ack(client, "auth:refresh", {
    accessToken: another.token,
  }).catch(() => null);
  if (result) assert.equal(result.ok, false);
  await until(() => !client.connected);
});

test("T04 orphaned worker leases expire safely when two workers sweep concurrently", async () => {
  const session = await f.lesson(),
    visit = await enter(session);
  // Model a process that died without a Socket.IO disconnect callback.
  const past = new Date(Date.now() - 6000);
  await f.prisma.classParticipation.update({
    where: { id: visit.id },
    data: { joinedAt: past, lastSeenAt: past },
  });
  await f.prisma.classPresenceLease.create({
    data: {
      participationId: visit.id,
      authSessionId: f.viewer.authSessionId,
      instanceId: randomUUID(),
      socketId: "dead-worker",
      lastHeartbeatAt: past,
      expiresAt: new Date(past.getTime() + 2400),
    },
  });
  await Promise.all([
    f.app.get(ClassPresenceService).sweep(),
    f.second.get(ClassPresenceService).sweep(),
  ]);
  assert.equal(
    (await f.prisma.classParticipation.findUnique({ where: { id: visit.id } }))
      .leaveReason,
    "DISCONNECTED",
  );
  const request = expect(
    await f.api(
      f.viewer,
      "POST",
      `/sessions/${session.id}/join-requests`,
      {},
      { key: randomUUID() },
    ),
    200,
  ).request;
  assert.notEqual(request.id, visit.joinRequestId);
  assert.equal(request.status, "PENDING");
});

test("T04 disabled accounts lose live presence and sockets without another HTTP request", async () => {
  const actor = await f.account("disabled-realtime"),
    session = await f.meet();
  const visit = await enter(session, actor),
    client = await socket(actor);
  await watch(client, session);
  await ok(client, "participation:attach", body(session, visit));
  await f.prisma.user.update({
    where: { id: actor.id },
    data: { disabledAt: new Date() },
  });
  await until(() => !client.connected);
  await until(
    async () =>
      (
        await f.prisma.classParticipation.findUnique({
          where: { id: visit.id },
        })
      ).leftAt,
  );
  assert.equal(
    (await f.prisma.classParticipation.findUnique({ where: { id: visit.id } }))
      .leaveReason,
    "ACCESS_REVOKED",
  );
});

test("T04 HTTP access and delayed enter retries enforce expiration even before the sweeper runs", async () => {
  const isolated = await createClassSessionApiFixture({
    sessionRealtime: {
      pollIntervalMs: 60000,
      sweepIntervalMs: 60000,
      heartbeatIntervalMs: 400,
      leaseTtlMs: 2400,
    },
  });
  try {
    const session = await isolated.meet(),
      prefix = `/sessions/${session.id}`;
    const request = expect(
      await isolated.api(
        isolated.viewer,
        "POST",
        `${prefix}/join-requests`,
        {},
        { key: randomUUID() },
      ),
      200,
    ).request;
    expect(
      await isolated.api(
        isolated.owner,
        "PATCH",
        `${prefix}/join-requests/${request.id}`,
        { decision: "ACCEPT" },
      ),
      200,
    );
    const key = randomUUID();
    const visit = expect(
      await isolated.api(
        isolated.viewer,
        "POST",
        `${prefix}/enter`,
        {},
        { key },
      ),
      200,
    ).participation;
    const past = new Date(Date.now() - 6000);
    await isolated.prisma.classParticipation.update({
      where: { id: visit.id },
      data: { joinedAt: past, lastSeenAt: past },
    });
    const state = expect(
      await isolated.api(isolated.viewer, "GET", `${prefix}/admission`),
      200,
    );
    assert.equal(state.permissions.canEnter, false);
    assert.equal(state.permissions.canRequestJoin, true);
    expect(
      await isolated.api(isolated.viewer, "GET", `${prefix}/participants`),
      403,
    );
    expect(await isolated.api(isolated.viewer, "GET", prefix), 403);
    expect(
      await isolated.api(
        isolated.viewer,
        "POST",
        `${prefix}/enter`,
        {},
        { key },
      ),
      403,
      "ADMISSION_REVOKED",
    );
    assert.equal(
      (
        await isolated.prisma.classParticipation.findUnique({
          where: { id: visit.id },
        })
      ).leaveReason,
      "DISCONNECTED",
    );
    assert.equal(
      (
        await isolated.prisma.classJoinRequest.findUnique({
          where: { id: request.id },
        })
      ).status,
      "EXPIRED",
    );
    const fresh = expect(
      await isolated.api(
        isolated.viewer,
        "POST",
        `${prefix}/join-requests`,
        {},
        { key: randomUUID() },
      ),
      200,
    ).request;
    assert.notEqual(fresh.id, request.id);
  } finally {
    await isolated.cleanup();
  }
});

test("T04 disconnecting an already expired lease cannot extend its deadline", async () => {
  const session = await f.lesson(),
    visit = await enter(session);
  const past = new Date(Date.now() - 6000),
    instanceId = randomUUID(),
    socketId = "late-disconnect";
  await f.prisma.classPresenceLease.create({
    data: {
      participationId: visit.id,
      authSessionId: f.viewer.authSessionId,
      instanceId,
      socketId,
      lastHeartbeatAt: past,
      expiresAt: new Date(past.getTime() + 2400),
    },
  });
  const before = await f.prisma.classParticipation.findUnique({
    where: { id: visit.id },
  });
  await f.app
    .get(ClassPresenceService)
    .detach(
      {
        userId: f.viewer.id,
        authSessionId: f.viewer.authSessionId,
        instanceId,
        socketId,
      },
      session.id,
      visit.id,
    );
  const after = await f.prisma.classParticipation.findUnique({
    where: { id: visit.id },
  });
  assert.equal(after.lastSeenAt.toISOString(), before.lastSeenAt.toISOString());
});

test("T04 journal versions follow commit ordering across independent sessions so a dispatcher cannot skip changes", async () => {
  const first = await f.lesson(),
    second = await f.meet();
  let release, ready;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    ready = resolve;
  });
  const one = f.prisma.$transaction(
    async (tx) => {
      await tx.classSession.update({
        where: { id: first.id },
        data: { title: "First committed edit" },
      });
      ready();
      await gate;
    },
    { timeout: 10000 },
  );
  await entered;
  let secondDone = false;
  const two = f.prisma
    .$transaction(
      async (tx) => {
        await tx.classSession.update({
          where: { id: second.id },
          data: { title: "Second committed edit" },
        });
      },
      { timeout: 10000 },
    )
    .then(() => {
      secondDone = true;
    });
  try {
    await pause(150);
    assert.equal(secondDone, false);
  } finally {
    release();
    await Promise.all([one, two]);
  }
  const firstEvent = await f.prisma.classSessionChange.findFirst({
    where: { sessionId: first.id },
    orderBy: { version: "desc" },
  });
  const secondEvent = await f.prisma.classSessionChange.findFirst({
    where: { sessionId: second.id },
    orderBy: { version: "desc" },
  });
  assert.ok(firstEvent.version < secondEvent.version);
  // Startup takes a fresh high-water mark; reconnect snapshots recover current state.
  const gateway = f.second.get(ClassSessionsGateway);
  await gateway.flush();
  const client = await socket(f.owner);
  const snapshot = await watch(client, first);
  assert.ok(BigInt(snapshot.version) >= secondEvent.version);
});
