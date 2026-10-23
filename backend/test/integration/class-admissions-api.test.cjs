const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const {
  createClassSessionApiFixture,
  expect,
} = require("./class-session-api-fixture.cjs");
let f;
const url = (s, suffix) => `/sessions/${s.id}/${suffix}`;
const api = (...args) => f.api(...args);
const ask = async (s, actor = f.viewer, key = randomUUID(), target) =>
  expect(
    await api(actor, "POST", url(s, "join-requests"), {}, { key, target }),
    200,
  ).request;
const decide = (s, request, decision = "ACCEPT", actor = f.owner, target) =>
  api(
    actor,
    "PATCH",
    url(s, `join-requests/${request.id}`),
    { decision },
    { target },
  );
const enter = async (s, actor = f.viewer, key = randomUUID(), target) =>
  expect(await api(actor, "POST", url(s, "enter"), {}, { key, target }), 200)
    .participation;
const leave = (s, visit, actor = f.viewer) =>
  api(actor, "POST", url(s, `participations/${visit.id}/leave`), {});
const state = async (s, actor = f.viewer) =>
  expect(await api(actor, "GET", url(s, "admission")), 200);
before(
  async () => {
    f = await createClassSessionApiFixture();
  },
  { timeout: 120000 },
);
after(async () => {
  if (f) await f.cleanup();
});

test("T04 group admission separates pending, acceptance and actual entry; only entrants/managers see participants", async () => {
  const s = await f.lesson();
  const initial = await state(s);
  assert.equal(initial.permissions.canRequestJoin, true);
  assert.equal(initial.permissions.canEnter, false);
  expect(
    await api(f.viewer, "GET", url(s, "participants")),
    403,
    "ADMISSION_REQUIRED",
  );
  expect(
    await api(f.viewer, "POST", url(s, "enter"), {}, { key: randomUUID() }),
    403,
    "ADMISSION_REQUIRED",
  );
  const request = await ask(s);
  assert.equal(request.status, "PENDING");
  assert.equal((await state(s)).permissions.canRequestJoin, false);
  const queue = expect(await api(f.host, "GET", url(s, "join-requests")), 200);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].id, request.id);
  assert.deepEqual(Object.keys(queue.items[0].user).sort(), ["fullName", "id"]);
  expect(await api(f.viewer, "GET", url(s, "join-requests")), 403);
  expect(
    await api(f.viewer2, "GET", url(s, `join-requests/${request.id}`)),
    403,
  );
  expect(
    await api(f.viewer2, "PATCH", url(s, `join-requests/${request.id}`), {
      decision: "ACCEPT",
    }),
    403,
  );
  const accepted = expect(
    await decide(s, request, "ACCEPT", f.host),
    200,
  ).request;
  assert.equal(accepted.decidedById, f.host.id);
  assert.equal((await state(s)).permissions.canEnter, true);
  assert.equal((await state(s)).permissions.canViewParticipants, false);
  assert.equal(
    expect(await api(f.owner, "GET", url(s, "participants")), 200).items.length,
    0,
  );
  expect(await api(f.viewer, "GET", url(s, "participants")), 403);
  const visit = await enter(s);
  assert.equal(visit.joinRequestId, request.id);
  assert.equal(visit.leftAt, null);
  const present = expect(
    await api(f.viewer, "GET", url(s, "participants")),
    200,
  );
  assert.equal(present.items.length, 1);
  assert.equal(present.items[0].userId, f.viewer.id);
  assert.deepEqual(Object.keys(present.items[0].user).sort(), [
    "fullName",
    "id",
  ]);
  assert.equal((await state(s)).permissions.canViewParticipants, true);
  assert.equal(await f.prisma.groupRoom.count(), 0);
});

test("T04 request keys prevent delayed retries after rejection/cancellation from creating a new request", async () => {
  const s = await f.lesson(),
    key = randomUUID();
  const request = await ask(s, f.viewer, key);
  const duplicate = await ask(s, f.viewer, randomUUID(), f.otherBase);
  assert.equal(duplicate.id, request.id);
  const rejected = expect(await decide(s, request, "REJECT"), 200).request;
  const replay = await ask(s, f.viewer, key, f.otherBase);
  assert.equal(replay.id, request.id);
  assert.equal(replay.status, "REJECTED");
  assert.equal(
    await f.prisma.classJoinRequest.count({ where: { sessionId: s.id } }),
    1,
  );
  const sameDecision = expect(
    await decide(s, request, "REJECT", f.host),
    200,
  ).request;
  assert.equal(sameDecision.decidedAt, rejected.decidedAt);
  assert.equal(sameDecision.decidedById, rejected.decidedById);
  expect(
    await decide(s, request, "ACCEPT"),
    409,
    "JOIN_REQUEST_ALREADY_RESOLVED",
  );
  const nextKey = randomUUID(),
    next = await ask(s, f.viewer, nextKey);
  assert.notEqual(next.id, request.id);
  expect(
    await api(f.owner, "POST", url(s, `join-requests/${next.id}/cancel`), {}),
    403,
  );
  const cancelled = expect(
    await api(f.viewer, "POST", url(s, `join-requests/${next.id}/cancel`), {}),
    200,
  ).request;
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(
    expect(
      await api(
        f.viewer,
        "POST",
        url(s, `join-requests/${next.id}/cancel`),
        {},
      ),
      200,
    ).request.closedAt,
    cancelled.closedAt,
  );
  expect(await decide(s, next), 409);
  assert.equal((await ask(s, f.viewer, nextKey)).status, "CANCELLED");
  assert.equal((await state(s)).permissions.canRequestJoin, true);
});

test("T04 cross-instance simultaneous requests/entries create one current request and one open visit", async () => {
  const s = await f.lesson(),
    key = randomUUID();
  const requests = await Promise.all([
    ask(s, f.viewer, key),
    ask(s, f.viewer, key, f.otherBase),
    ask(s, f.viewer, randomUUID(), f.otherBase),
  ]);
  assert.equal(new Set(requests.map((x) => x.id)).size, 1);
  expect(await decide(s, requests[0]), 200);
  const entryKey = randomUUID();
  const visits = await Promise.all([
    enter(s, f.viewer, entryKey),
    enter(s, f.viewer, entryKey, f.otherBase),
    enter(s, f.viewer, randomUUID(), f.otherBase),
  ]);
  assert.equal(new Set(visits.map((x) => x.id)).size, 1);
  assert.equal(
    await f.prisma.classParticipation.count({ where: { sessionId: s.id } }),
    1,
  );
});

test("T04 leave expires admission; late retries cannot reopen or close a later visit", async () => {
  const s = await f.lesson(),
    requestKey = randomUUID(),
    enterKey = randomUUID();
  const request = await ask(s, f.viewer, requestKey);
  expect(await decide(s, request), 200);
  const visit = await enter(s, f.viewer, enterKey);
  expect(await leave(s, visit, f.viewer2), 403);
  const closed = expect(await leave(s, visit), 200).participation;
  assert.equal(closed.leaveReason, "LEFT");
  assert.equal(
    expect(await leave(s, visit), 200).participation.leftAt,
    closed.leftAt,
  );
  assert.equal((await ask(s, f.viewer, requestKey)).status, "EXPIRED");
  expect(
    await api(f.viewer, "POST", url(s, "enter"), {}, { key: enterKey }),
    403,
    "ADMISSION_REVOKED",
  );
  expect(
    await api(f.viewer, "POST", url(s, "enter"), {}, { key: randomUUID() }),
    403,
    "ADMISSION_REQUIRED",
  );
  const next = await ask(s);
  expect(await decide(s, next), 200);
  const nextVisit = await enter(s);
  assert.notEqual(nextVisit.id, visit.id);
  assert.notEqual(next.id, request.id);
  expect(await leave(s, visit), 200);
  assert.equal(
    (
      await f.prisma.classParticipation.findUniqueOrThrow({
        where: { id: nextVisit.id },
      })
    ).leftAt,
    null,
  );
  expect(
    await api(f.viewer, "POST", url(s, "enter"), {}, { key: enterKey }),
    403,
    "ADMISSION_REVOKED",
  );
  const managerKey = randomUUID(),
    managerVisit = await enter(s, f.host, managerKey);
  assert.equal(managerVisit.joinRequestId, null);
  expect(await leave(s, managerVisit, f.host), 200);
  expect(
    await api(f.host, "POST", url(s, "enter"), {}, { key: managerKey }),
    403,
  );
  const newManagerVisit = await enter(s, f.host);
  expect(await leave(s, managerVisit, f.host), 200);
  assert.equal(
    (
      await f.prisma.classParticipation.findUniqueOrThrow({
        where: { id: newManagerVisit.id },
      })
    ).leftAt,
    null,
  );
});

test("T04 independent meet permits requests without membership but only owner/ADMIN can approve", async () => {
  const s = await f.meet();
  const request = await ask(s, f.outsider);
  expect(await api(f.outsider, "GET", `/sessions/${s.id}`), 403);
  expect(await decide(s, request, "ACCEPT", f.host), 403);
  expect(await decide(s, request, "ACCEPT", f.admin), 200);
  expect(await api(f.outsider, "GET", `/sessions/${s.id}`), 403);
  assert.equal((await state(s, f.outsider)).permissions.canEnter, true);
  const visit = await enter(s, f.outsider);
  expect(await api(f.outsider, "GET", `/sessions/${s.id}`), 200);
  expect(await leave(s, visit, f.outsider), 200);
  expect(await api(f.outsider, "GET", `/sessions/${s.id}`), 403);
  assert.equal((await state(s, f.outsider)).permissions.canRequestJoin, true);
  expect(await api(f.host, "GET", url(s, "join-requests")), 403);
});

test("T04 validates all admission identifiers, ownership, bodies and required keys", async () => {
  const s = await f.lesson(),
    other = await f.lesson(),
    request = await ask(s);
  expect(await api(null, "GET", url(s, "admission")), 401);
  expect(await api(f.outsider, "GET", url(s, "admission")), 403);
  expect(
    await api(
      f.outsider,
      "POST",
      url(s, "join-requests"),
      {},
      { key: randomUUID() },
    ),
    403,
  );
  for (const suffix of ["join-requests", "enter"]) {
    expect(await api(f.viewer, "POST", url(s, suffix), {}), 400);
    expect(
      await api(f.viewer, "POST", url(s, suffix), {}, { key: "bad key" }),
      400,
    );
    for (const body of [
      { userId: f.owner.id },
      { role: "HOST" },
      { status: "ACCEPTED" },
    ])
      expect(
        await api(f.viewer, "POST", url(s, suffix), body, {
          key: randomUUID(),
        }),
        400,
      );
  }
  for (const decision of ["ACCEPTED", "accept", null, ["ACCEPT"]])
    expect(
      await api(f.owner, "PATCH", url(s, `join-requests/${request.id}`), {
        decision,
      }),
      400,
    );
  expect(
    await api(f.owner, "PATCH", url(s, `join-requests/${request.id}`), {
      decision: "ACCEPT",
      decidedById: f.host.id,
    }),
    400,
  );
  expect(await api(f.owner, "GET", url(s, "join-requests/not-an-id")), 400);
  expect(
    await api(f.owner, "PATCH", url(other, `join-requests/${request.id}`), {
      decision: "ACCEPT",
    }),
    404,
    "JOIN_REQUEST_NOT_FOUND",
  );
  const visit = await enter(s, f.owner);
  expect(
    await api(
      f.owner,
      "POST",
      url(other, `participations/${visit.id}/leave`),
      {},
    ),
    404,
  );
  for (const query of [
    "limit=101",
    "status=pending",
    "status=PENDING&status=REJECTED",
    "userId=forged",
  ])
    expect(await api(f.owner, "GET", url(s, `join-requests?${query}`)), 400);
  expect(await api(f.owner, "GET", url(s, "participants?status=LEFT")), 400);
});

test("T04 cannot request or enter before LIVE or after ENDED/CANCELLED", async () => {
  const s = await f.lesson({ live: false });
  for (const actor of [f.viewer, f.owner]) {
    expect(
      await api(
        actor,
        "POST",
        url(s, "join-requests"),
        {},
        { key: randomUUID() },
      ),
      409,
      "SESSION_NOT_LIVE",
    );
    expect(
      await api(actor, "POST", url(s, "enter"), {}, { key: randomUUID() }),
      409,
      "SESSION_NOT_LIVE",
    );
  }
  expect(await api(f.owner, "POST", url(s, "cancel"), {}), 200);
  expect(
    await api(
      f.viewer,
      "POST",
      url(s, "join-requests"),
      {},
      { key: randomUUID() },
    ),
    409,
  );
  const live = await f.lesson(),
    request = await ask(live);
  expect(await api(f.owner, "POST", url(live, "end"), {}), 200);
  expect(await decide(live, request), 409, "SESSION_NOT_LIVE");
  expect(
    await api(f.owner, "POST", url(live, "enter"), {}, { key: randomUUID() }),
    409,
  );
  assert.equal((await state(live)).permissions.canEnter, false);
  assert.equal((await state(live)).request.status, "EXPIRED");
});

test("T04 queue and participant cursors stay scoped to session, actor and filter", async () => {
  const s = await f.meet(),
    other = await f.meet();
  const guests = await Promise.all(
    ["page-a", "page-b", "page-c", "page-d"].map(f.account),
  );
  const requests = await Promise.all(guests.map((actor) => ask(s, actor)));
  const first = expect(
    await api(f.owner, "GET", url(s, "join-requests?limit=2")),
    200,
  );
  const next = expect(
    await api(
      f.owner,
      "GET",
      url(s, `join-requests?limit=2&cursor=${first.nextCursor}`),
    ),
    200,
  );
  assert.equal(
    new Set([...first.items, ...next.items].map((x) => x.id)).size,
    4,
  );
  assert.equal(next.nextCursor, null);
  for (const [actor, target, suffix] of [
    [f.admin, s, `join-requests?cursor=${first.nextCursor}`],
    [f.owner, other, `join-requests?cursor=${first.nextCursor}`],
    [f.owner, s, `join-requests?status=REJECTED&cursor=${first.nextCursor}`],
  ])
    expect(await api(actor, "GET", url(target, suffix)), 400, "INVALID_CURSOR");
  for (let i = 0; i < guests.length; i++) {
    expect(await decide(s, requests[i]), 200);
    await enter(s, guests[i]);
  }
  const present = expect(
    await api(f.owner, "GET", url(s, "participants?limit=2")),
    200,
  );
  assert.ok(present.nextCursor);
  const rest = expect(
    await api(
      guests[0],
      "GET",
      url(s, `participants?cursor=${present.nextCursor}`),
    ),
    400,
    "INVALID_CURSOR",
  );
  assert.ok(rest.error);
  const second = expect(
    await api(
      f.owner,
      "GET",
      url(s, `participants?limit=2&cursor=${present.nextCursor}`),
    ),
    200,
  );
  assert.equal(
    new Set([...present.items, ...second.items].map((x) => x.userId)).size,
    4,
  );
  for (const row of [...present.items, ...second.items])
    assert.deepEqual(Object.keys(row.user).sort(), ["fullName", "id"]);
});

test("T04 accept/reject and cancel/accept races cannot overwrite a resolved request", async () => {
  const s = await f.lesson(),
    request = await ask(s);
  const results = await Promise.all([
    decide(s, request, "ACCEPT", f.owner),
    decide(s, request, "REJECT", f.host, f.otherBase),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  const stored = await f.prisma.classJoinRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  assert.ok(stored.decidedAt);
  assert.equal(
    stored.status,
    results[0].status === 200 ? "ACCEPTED" : "REJECTED",
  );
  const s2 = await f.lesson(),
    next = await ask(s2);
  const mixed = await Promise.all([
    api(f.viewer, "POST", url(s2, `join-requests/${next.id}/cancel`), {}),
    decide(s2, next, "ACCEPT", f.host, f.otherBase),
  ]);
  assert.deepEqual(mixed.map((x) => x.status).sort(), [200, 409]);
});

test("T04 accepted requests and entrants are expired when end races approval or entry", async () => {
  const s = await f.lesson(),
    request = await ask(s);
  const [approval, end] = await Promise.all([
    decide(s, request),
    api(f.host, "POST", url(s, "end"), {}, { target: f.otherBase }),
  ]);
  assert.ok([200, 409].includes(approval.status));
  expect(end, 200);
  assert.equal(
    (
      await f.prisma.classJoinRequest.findUniqueOrThrow({
        where: { id: request.id },
      })
    ).status,
    "EXPIRED",
  );
  const next = await f.lesson(),
    accepted = await ask(next);
  expect(await decide(next, accepted), 200);
  const [entered, ended] = await Promise.all([
    api(f.viewer, "POST", url(next, "enter"), {}, { key: randomUUID() }),
    api(f.host, "POST", url(next, "end"), {}, { target: f.otherBase }),
  ]);
  assert.ok([200, 409].includes(entered.status));
  expect(ended, 200);
  assert.equal(
    await f.prisma.classParticipation.count({
      where: { sessionId: next.id, leftAt: null },
    }),
    0,
  );
  assert.equal((await state(next)).permissions.canEnter, false);
});

test("T04 removing/readding membership revokes waiting, accepted and entered access permanently", async () => {
  const s = await f.lesson(),
    key = randomUUID(),
    request = await ask(s, f.viewer, key);
  expect(await decide(s, request), 200);
  const entryKey = randomUUID(),
    visit = await enter(s, f.viewer, entryKey);
  expect(
    await api(f.owner, "DELETE", `/groups/${s.groupId}/members/${f.viewer.id}`),
    204,
  );
  const closed = await f.prisma.classParticipation.findUniqueOrThrow({
    where: { id: visit.id },
  });
  assert.equal(closed.leaveReason, "ACCESS_REVOKED");
  assert.equal(
    (
      await f.prisma.classJoinRequest.findUniqueOrThrow({
        where: { id: request.id },
      })
    ).status,
    "REVOKED",
  );
  expect(await api(f.viewer, "GET", url(s, "admission")), 403);
  expect(
    await api(f.owner, "POST", `/groups/${s.groupId}/members`, {
      userId: f.viewer.id,
      role: "VIEWER",
    }),
    201,
  );
  assert.equal((await state(s)).permissions.canEnter, false);
  assert.equal((await ask(s, f.viewer, key)).status, "REVOKED");
  expect(
    await api(f.viewer, "POST", url(s, "enter"), {}, { key: entryKey }),
    403,
    "ADMISSION_REVOKED",
  );
  expect(await decide(s, request), 409, "JOIN_REQUEST_ALREADY_RESOLVED");
  const fresh = await ask(s);
  assert.notEqual(fresh.id, request.id);
  const pending = await ask(s, f.viewer2);
  const [approved, removed] = await Promise.all([
    decide(s, pending),
    api(
      f.owner,
      "DELETE",
      `/groups/${s.groupId}/members/${f.viewer2.id}`,
      undefined,
      { target: f.otherBase },
    ),
  ]);
  assert.ok([200, 403].includes(approved.status));
  expect(removed, 204);
  assert.equal(
    (
      await f.prisma.classJoinRequest.findUniqueOrThrow({
        where: { id: pending.id },
      })
    ).status,
    "REVOKED",
  );
});

test("T04 target eligibility is rechecked and failed approval commits revocation", async () => {
  const s = await f.meet(),
    guest = await f.account("disabled-at-review"),
    request = await ask(s, guest);
  await f.prisma.user.update({
    where: { id: guest.id },
    data: { disabledAt: new Date() },
  });
  expect(await decide(s, request), 403, "ADMISSION_REVOKED");
  assert.equal(
    (
      await f.prisma.classJoinRequest.findUniqueOrThrow({
        where: { id: request.id },
      })
    ).status,
    "REVOKED",
  );
});

test("T04 detecting a disabled account closes its visits/approvals across rooms and does not restore them on unlock", async () => {
  const s = await f.meet(),
    other = await f.meet(),
    guest = await f.account("disabled-in-room");
  const key = randomUUID(),
    request = await ask(s, guest, key);
  expect(await decide(s, request), 200);
  const visit = await enter(s, guest);
  const waiting = await ask(other, guest);
  await f.prisma.user.update({
    where: { id: guest.id },
    data: { disabledAt: new Date() },
  });
  assert.ok(
    !expect(await api(f.owner, "GET", url(s, "participants")), 200).items.some(
      (x) => x.userId === guest.id,
    ),
  );
  expect(await api(guest, "GET", url(s, "admission")), 403, "USER_DISABLED");
  assert.equal(
    (
      await f.prisma.classParticipation.findUniqueOrThrow({
        where: { id: visit.id },
      })
    ).leaveReason,
    "ACCESS_REVOKED",
  );
  for (const id of [request.id, waiting.id])
    assert.equal(
      (await f.prisma.classJoinRequest.findUniqueOrThrow({ where: { id } }))
        .status,
      "REVOKED",
    );
  await f.prisma.user.update({
    where: { id: guest.id },
    data: { disabledAt: null },
  });
  expect(await api(guest, "GET", url(s, "admission")), 401);
  const renewed = await f.issue(guest);
  assert.equal((await state(s, renewed)).permissions.canEnter, false);
  assert.equal((await ask(s, renewed, key)).status, "REVOKED");
  expect(
    await api(renewed, "POST", url(s, "enter"), {}, { key: randomUUID() }),
    403,
    "ADMISSION_REQUIRED",
  );
});

test("T04 promotion permits direct entry; downgrade preserves a current visit but removes management", async () => {
  const s = await f.lesson(),
    request = await ask(s);
  expect(
    await api(f.owner, "PATCH", `/groups/${s.groupId}/members/${f.viewer.id}`, {
      role: "HOST",
    }),
    200,
  );
  const visit = await enter(s);
  assert.equal(visit.joinRequestId, null);
  assert.equal(
    (
      await f.prisma.classJoinRequest.findUniqueOrThrow({
        where: { id: request.id },
      })
    ).status,
    "EXPIRED",
  );
  expect(
    await api(f.owner, "PATCH", `/groups/${s.groupId}/members/${f.viewer.id}`, {
      role: "VIEWER",
    }),
    200,
  );
  const current = await state(s);
  assert.equal(current.permissions.canManage, false);
  assert.equal(current.permissions.canViewParticipants, true);
  expect(await api(f.viewer, "GET", url(s, "join-requests")), 403);
  expect(await leave(s, visit), 200);
  expect(
    await api(f.viewer, "POST", url(s, "enter"), {}, { key: randomUUID() }),
    403,
    "ADMISSION_REQUIRED",
  );
});

test("T04 a key cannot be reused for another session, and stale request history cannot override current admission", async () => {
  const s = await f.lesson(),
    other = await f.lesson(),
    key = randomUUID();
  const old = await ask(s, f.viewer, key);
  expect(
    await api(f.viewer, "POST", url(other, "join-requests"), {}, { key }),
    409,
    "IDEMPOTENCY_CONFLICT",
  );
  expect(await decide(s, old, "REJECT"), 200);
  const fresh = await ask(s);
  // Tie the timestamps to verify state prioritizes a current grant over closed history.
  await f.prisma.classJoinRequest.update({
    where: { id: fresh.id },
    data: { requestedAt: new Date(old.requestedAt) },
  });
  assert.equal((await state(s)).request.id, fresh.id);
  expect(await decide(s, fresh), 200);
  const enterKey = randomUUID();
  await enter(s, f.viewer, enterKey);
  expect(
    await api(f.viewer, "POST", url(other, "enter"), {}, { key: enterKey }),
    409,
    "IDEMPOTENCY_CONFLICT",
  );
});
