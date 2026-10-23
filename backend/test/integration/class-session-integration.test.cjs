const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
require("reflect-metadata");
const {
  Controller,
  Get,
  Module,
  Global,
  UseGuards,
} = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const {
  createClassSessionApiFixture,
  expect,
} = require("./class-session-api-fixture.cjs");
const {
  ClassSessionsModule,
} = require("../../dist/modules/class-sessions/class-sessions.module");
const {
  ClassParticipantService,
} = require("../../dist/modules/class-sessions/class-participant.service");
const {
  ClassParticipantGuard,
  RequireClassParticipation,
  CurrentClassParticipant,
} = require("../../dist/modules/class-sessions/class-participant.guard");
const {
  ClassSessionEventsModule,
} = require("../../dist/modules/class-sessions/class-session-events.module");
const {
  ClassSessionEventsService,
} = require("../../dist/modules/class-sessions/class-session-events.service");
const {
  ClassSessionsGateway,
} = require("../../dist/modules/class-sessions/class-sessions.gateway");
const {
  AccessTokenGuard,
} = require("../../dist/common/auth/access-token.guard");
const { PrismaService } = require("../../dist/database/prisma.service");

// Test-only next-task module: no integration probe routes ship in the API.
class NextTaskController {
  participant(context) {
    return context;
  }
  manager(context) {
    return context;
  }
  missing(context) {
    return context;
  }
  unconfigured(context) {
    return context;
  }
  custom(context) {
    return context;
  }
}
Controller("t04-integration-probe")(NextTaskController);
function decorate(name, ...decorators) {
  for (const decorator of decorators)
    decorator(
      NextTaskController.prototype,
      name,
      Object.getOwnPropertyDescriptor(NextTaskController.prototype, name),
    );
  CurrentClassParticipant()(NextTaskController.prototype, name, 0);
}
decorate(
  "participant",
  Get(":sessionId/:participationId/participant"),
  RequireClassParticipation(),
);
decorate(
  "manager",
  Get(":sessionId/:participationId/manager"),
  RequireClassParticipation({ manage: true }),
);
decorate("missing", Get(":sessionId/:participationId/missing"));
decorate(
  "unconfigured",
  Get(":sessionId/:participationId/unconfigured"),
  UseGuards(AccessTokenGuard, ClassParticipantGuard),
);
decorate(
  "custom",
  Get(":lessonId/:visitId/custom"),
  RequireClassParticipation({
    sessionParam: "lessonId",
    participationParam: "visitId",
  }),
);
class NextTaskModule {}
Module({ imports: [ClassSessionsModule], controllers: [NextTaskController] })(
  NextTaskModule,
);

let f, participants, events, otherEvents;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
before(
  async () => {
    f = await createClassSessionApiFixture({ imports: [NextTaskModule] });
    participants = f.app.get(ClassParticipantService);
    events = f.app.get(ClassSessionEventsService);
    otherEvents = f.second.get(ClassSessionEventsService);
    await f.prisma.$executeRawUnsafe(
      "CREATE TABLE integration_effects (consumer TEXT NOT NULL, event_id UUID NOT NULL, session_id UUID NOT NULL, PRIMARY KEY(consumer,event_id))",
    );
  },
  { timeout: 120000 },
);
after(async () => {
  if (f) await f.cleanup();
});
const actor = (user) => ({
  userId: user.id,
  authSessionId: user.authSessionId,
});
const probe = (session, visit, action = "participant") =>
  `/t04-integration-probe/${session.id}/${visit.id}/${action}`;
const consumer = () => `t04-${randomUUID()}`;
async function join(session, user = f.viewer) {
  const { request } = expect(
    await f.api(
      user,
      "POST",
      `/sessions/${session.id}/join-requests`,
      {},
      { key: randomUUID() },
    ),
    200,
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
  return request;
}
async function enter(session, user = f.viewer) {
  return expect(
    await f.api(
      user,
      "POST",
      `/sessions/${session.id}/enter`,
      {},
      { key: randomUUID() },
    ),
    200,
  ).participation;
}
async function end(session) {
  return expect(
    await f.api(
      f.owner,
      "POST",
      `/sessions/${session.id}/end`,
      {},
      { key: randomUUID() },
    ),
    200,
  );
}
const failure = (status) => (error) => error.getStatus?.() === status;
const effect = (name) => async (message, tx) => {
  await tx.$executeRaw`INSERT INTO integration_effects(consumer,event_id,session_id) VALUES (${name},${message.payload.eventId}::uuid,${message.payload.sessionId}::uuid)`;
};
async function effectCount(name) {
  const [row] = await f.prisma
    .$queryRaw`SELECT count(*)::integer AS count FROM integration_effects WHERE consumer=${name}`;
  return row.count;
}

test("T04 integration guard requires actual entry even for managers and accepted users", async () => {
  const session = await f.lesson(),
    nonexistent = { id: randomUUID() };
  expect(await f.api(null, "GET", probe(session, nonexistent)), 401);
  expect(
    await f.api(f.owner, "GET", probe(session, nonexistent)),
    403,
    "ADMISSION_REQUIRED",
  );
  expect(
    await f.api(f.viewer, "GET", probe(session, nonexistent)),
    403,
    "ADMISSION_REQUIRED",
  );
  await join(session);
  expect(
    await f.api(f.viewer, "GET", probe(session, nonexistent)),
    403,
    "ADMISSION_REQUIRED",
  );
  const visit = await enter(session);
  const context = expect(
    await f.api(f.viewer, "GET", probe(session, visit)),
    200,
  );
  assert.deepEqual(context.session, {
    id: session.id,
    kind: "GROUP",
    groupId: session.groupId,
    status: "LIVE",
  });
  assert.equal(context.userId, f.viewer.id);
  assert.equal(context.participationId, visit.id);
  assert.equal(context.authSessionId, f.viewer.authSessionId);
  assert.equal(context.canManage, false);
  assert.equal(new Date(context.checkedAt).toISOString(), context.checkedAt);
  assert.doesNotMatch(
    JSON.stringify(context),
    /email|password|joinCode|accessToken/,
  );
  const hostVisit = await enter(session, f.owner);
  assert.equal(
    expect(
      await f.api(f.owner, "GET", probe(session, hostVisit, "manager")),
      200,
    ).canManage,
    true,
  );
});

test("T04 integration validates resource IDs, binds the exact visit and ignores forged identity/group fields", async () => {
  const session = await f.lesson();
  await join(session);
  const visit = await enter(session);
  expect(
    await f.api(f.viewer, "GET", probe(session, { id: randomUUID() })),
    403,
    "ADMISSION_REVOKED",
  );
  expect(
    await f.api(f.viewer2, "GET", probe(session, visit)),
    403,
    "ADMISSION_REQUIRED",
  );
  expect(
    await f.api(
      f.outsider,
      "GET",
      `${probe(session, visit)}?groupId=${session.groupId}&userId=${f.viewer.id}`,
    ),
    403,
    "FORBIDDEN",
  );
  expect(
    await f.api(
      f.viewer,
      "GET",
      `/t04-integration-probe/bad-id/${visit.id}/participant`,
    ),
    400,
    "VALIDATION_ERROR",
  );
  expect(
    await f.api(f.viewer, "GET", probe(session, { id: "bad-id" })),
    400,
    "VALIDATION_ERROR",
  );
  expect(
    await f.api(f.viewer, "GET", probe(session, visit, "missing")),
    403,
    "ADMISSION_REQUIRED",
  );
  expect(
    await f.api(f.viewer, "GET", probe(session, visit, "unconfigured")),
    403,
    "ADMISSION_REQUIRED",
  );
  assert.equal(
    expect(await f.api(f.viewer, "GET", probe(session, visit, "custom")), 200)
      .participationId,
    visit.id,
  );
  const other = await f.lesson();
  expect(
    await f.api(f.viewer, "GET", probe(other, visit)),
    403,
    "ADMISSION_REQUIRED",
  );
});

test("T04 integration rechecks management after downgrade and blocks removed membership", async () => {
  const session = await f.lesson();
  const visit = await enter(session, f.host);
  expect(await f.api(f.host, "GET", probe(session, visit, "manager")), 200);
  expect(
    await f.api(
      f.owner,
      "PATCH",
      `/groups/${session.groupId}/members/${f.host.id}`,
      { role: "VIEWER" },
    ),
    200,
  );
  expect(
    await f.api(f.host, "GET", probe(session, visit, "manager")),
    403,
    "FORBIDDEN",
  );
  assert.equal(
    expect(await f.api(f.host, "GET", probe(session, visit)), 200).canManage,
    false,
  );
  expect(
    await f.api(
      f.owner,
      "DELETE",
      `/groups/${session.groupId}/members/${f.host.id}`,
    ),
    204,
  );
  expect(await f.api(f.host, "GET", probe(session, visit)), 403, "FORBIDDEN");
  expect(
    await f.api(f.owner, "POST", `/groups/${session.groupId}/members`, {
      userId: f.host.id,
      role: "HOST",
    }),
    201,
  );
  expect(
    await f.api(f.host, "GET", probe(session, visit)),
    403,
    "ADMISSION_REQUIRED",
  );
});

test("T04 integration does not reuse a closed or expired visit, including before sweep", async () => {
  const session = await f.lesson();
  await join(session);
  const old = await enter(session);
  expect(
    await f.api(
      f.viewer,
      "POST",
      `/sessions/${session.id}/participations/${old.id}/leave`,
      {},
    ),
    200,
  );
  await join(session);
  const current = await enter(session);
  expect(
    await f.api(f.viewer, "GET", probe(session, old)),
    403,
    "ADMISSION_REVOKED",
  );
  expect(await f.api(f.viewer, "GET", probe(session, current)), 200);
  const past = new Date(Date.now() - 60000);
  await f.prisma.classParticipation.update({
    where: { id: current.id },
    data: { joinedAt: past, lastSeenAt: past },
  });
  expect(
    await f.api(f.viewer, "GET", probe(session, current)),
    403,
    "ADMISSION_REQUIRED",
  );
});

test("T04 integration respects live auth sessions, disabled users and current server ownership for meets", async () => {
  const session = await f.meet();
  await join(session, f.outsider);
  const visit = await enter(session, f.outsider);
  expect(await f.api(f.outsider, "GET", probe(session, visit)), 200);
  expect(
    await f.api(f.outsider, "GET", probe(session, visit, "manager")),
    403,
    "FORBIDDEN",
  );
  const login = await f.issue(f.outsider);
  await f.prisma.authSession.update({
    where: { id: login.authSessionId },
    data: { revokedAt: new Date(), revocationReason: "LOGOUT" },
  });
  expect(
    await f.api(login, "GET", probe(session, visit)),
    401,
    "UNAUTHENTICATED",
  );
  await assert.rejects(
    participants.require(actor(login), session.id, visit.id),
    failure(401),
  );
  await assert.rejects(
    participants.require(
      { userId: f.outsider.id, authSessionId: f.owner.authSessionId },
      session.id,
      visit.id,
    ),
    failure(401),
  );
  const disabled = await f.account("integration-disabled");
  await join(session, disabled);
  const disabledVisit = await enter(session, disabled);
  await f.prisma.user.update({
    where: { id: disabled.id },
    data: { disabledAt: new Date() },
  });
  expect(
    await f.api(disabled, "GET", probe(session, disabledVisit)),
    403,
    "USER_DISABLED",
  );
  expect(await f.api(f.outsider, "GET", probe(session, visit)), 200);
});

test("T04 integration blocks scheduled/ended sessions and exports no media tokens", async () => {
  const session = await f.lesson({ live: false });
  expect(
    await f.api(f.owner, "GET", probe(session, { id: randomUUID() })),
    409,
    "SESSION_NOT_LIVE",
  );
  expect(
    await f.api(f.owner, "POST", `/sessions/${session.id}/start`, {}),
    200,
  );
  const visit = await enter(session, f.owner);
  await end(session);
  expect(
    await f.api(f.owner, "GET", probe(session, visit)),
    409,
    "SESSION_NOT_LIVE",
  );
  const doc = expect(await f.api(null, "GET", "/docs-sessions-json"), 200);
  assert.equal(Object.values(doc.paths).flatMap(Object.values).length, 19);
  assert.ok(!JSON.stringify(doc.paths).includes("integration-probe"));
});

test("T04 integration callback rolls back DB effects and serializes with ending on another server", async () => {
  const session = await f.lesson();
  await join(session);
  const visit = await enter(session);
  const name = consumer();
  await assert.rejects(
    participants.withParticipant(
      actor(f.viewer),
      session.id,
      visit.id,
      async (_context, tx) => {
        await tx.$executeRaw`INSERT INTO integration_effects(consumer,event_id,session_id) VALUES (${name},${randomUUID()}::uuid,${session.id}::uuid)`;
        throw new Error("rollback integration operation");
      },
    ),
    /rollback integration operation/,
  );
  assert.equal(await effectCount(name), 0);
  let release, entered;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    ready = new Promise((resolve) => {
      entered = resolve;
    });
  const operation = participants.withParticipant(
    actor(f.viewer),
    session.id,
    visit.id,
    async (_context, tx) => {
      entered();
      await gate;
      await tx.$executeRaw`INSERT INTO integration_effects(consumer,event_id,session_id) VALUES (${name},${randomUUID()}::uuid,${session.id}::uuid)`;
    },
  );
  await ready;
  let ended = false;
  const ending = f
    .api(
      f.owner,
      "POST",
      `/sessions/${session.id}/end`,
      {},
      { target: f.otherBase },
    )
    .then((result) => {
      expect(result, 200);
      ended = true;
    });
  try {
    await pause(100);
    assert.equal(ended, false);
  } finally {
    release();
    await Promise.all([operation, ending]);
  }
  assert.equal(await effectCount(name), 1);
  let executed = false;
  await assert.rejects(
    participants.withParticipant(
      actor(f.viewer),
      session.id,
      visit.id,
      async () => {
        executed = true;
      },
    ),
    failure(409),
  );
  assert.equal(executed, false);
});

test("T04 business event consumer reads retained history in order and does not consume Socket.IO invalidations", async () => {
  const session = await f.meet();
  await end(session);
  await end(session);
  const cancelled = await f.lesson({ live: false });
  expect(
    await f.api(f.owner, "POST", `/sessions/${cancelled.id}/cancel`, {}),
    200,
  );
  const rows = await f.prisma.classSessionEndEvent.findMany({
    orderBy: { version: "asc" },
  });
  const name = consumer(),
    delivered = [];
  assert.equal(
    await events.consumeBatch(name, async (message, tx) => {
      delivered.push(message);
      await effect(name)(message, tx);
    }),
    rows.length,
  );
  assert.deepEqual(
    delivered.map((message) => message.payload.eventId),
    rows.map((row) => row.eventId),
  );
  assert.ok(
    delivered.every(
      (message) =>
        message.type === "session.ended.v1" &&
        typeof message.payload.version === "string",
    ),
  );
  assert.equal(
    delivered.filter((message) => message.payload.sessionId === session.id)
      .length,
    1,
  );
  assert.equal(
    delivered.some((message) => message.payload.sessionId === cancelled.id),
    false,
  );
  assert.equal(await events.consumeNext(name, effect(name)), null);
  assert.equal(await effectCount(name), rows.length);
  assert.ok((await f.prisma.classSessionChange.count()) > rows.length);
});

test("T04 consumer rolls back handler effects/checkpoint on failure and retries the same event", async () => {
  const name = consumer();
  await events.consumeNext(name, effect(name));
  const before = await f.prisma.classSessionEndConsumer.findUnique({
    where: { name },
  });
  let attempted;
  await assert.rejects(
    events.consumeNext(name, async (message, tx) => {
      attempted = message;
      await effect(name)(message, tx);
      throw new Error("retry consumer");
    }),
    /retry consumer/,
  );
  assert.equal(
    (await f.prisma.classSessionEndConsumer.findUnique({ where: { name } }))
      .lastVersion,
    before.lastVersion,
  );
  assert.equal(await effectCount(name), 1);
  const retry = await otherEvents.consumeNext(name, effect(name));
  assert.deepEqual(retry, attempted);
  assert.equal(await effectCount(name), 2);
});

test("T04 two workers sharing a consumer commit each effect once and independent consumers each receive history", async () => {
  const name = consumer(),
    expected = await f.prisma.classSessionEndEvent.count();
  const processed = await Promise.all([
    events.consumeBatch(name, effect(name)),
    otherEvents.consumeBatch(name, effect(name)),
  ]);
  assert.equal(processed[0] + processed[1], expected);
  assert.equal(await effectCount(name), expected);
  const independent = consumer();
  assert.equal(
    await otherEvents.consumeBatch(independent, effect(independent)),
    expected,
  );
  assert.equal(await effectCount(independent), expected);
});

test("T04 restarted event service resumes its persisted checkpoint and bounded batches keep later events pending", async () => {
  const name = consumer();
  assert.equal(await events.consumeBatch(name, effect(name), 1), 1);
  const restarted = new ClassSessionEventsService(f.prisma),
    total = await f.prisma.classSessionEndEvent.count();
  assert.equal(await restarted.consumeBatch(name, effect(name)), total - 1);
  assert.equal(await effectCount(name), total);
  const late = await f.meet();
  await end(late);
  const next = await restarted.consumeNext(name, effect(name));
  assert.equal(next.payload.sessionId, late.id);
  assert.equal(await restarted.consumeNext(name, effect(name)), null);
});

test("T04 business event versions preserve bigint precision and consumer input is bounded", async () => {
  await f.prisma.$queryRawUnsafe(
    "SELECT setval('class_session_end_events_version_seq',9007199254740992,true)",
  );
  const session = await f.meet();
  await end(session);
  const row = await f.prisma.classSessionEndEvent.findUnique({
    where: { sessionId: session.id },
  });
  assert.equal(row.version, 9007199254740993n);
  const name = consumer(),
    received = [];
  await events.consumeBatch(name, async (message) => {
    received.push(message);
  });
  assert.equal(received.at(-1).payload.version, "9007199254740993");
  for (const invalid of [
    "",
    "Bad Name",
    "x".repeat(101),
    "test; DROP TABLE users",
  ])
    await assert.rejects(
      async () => events.consumeNext(invalid, async () => {}),
      failure(400),
    );
  for (const limit of [0, 101, 1.5])
    await assert.rejects(
      events.consumeBatch(name, async () => {}, limit),
      failure(400),
    );
});

test("T04 event module works in a separate worker context without socket or media gateways", async () => {
  class WorkerDatabase {}
  Global()(WorkerDatabase);
  Module({
    providers: [
      {
        provide: PrismaService,
        useValue: { $transaction: f.prisma.$transaction.bind(f.prisma) },
      },
    ],
    exports: [PrismaService],
  })(WorkerDatabase);
  class WorkerRoot {}
  Module({ imports: [WorkerDatabase, ClassSessionEventsModule] })(WorkerRoot);
  const worker = await NestFactory.createApplicationContext(WorkerRoot, {
    logger: false,
  });
  try {
    assert.throws(() => worker.get(ClassSessionsGateway));
    const name = consumer();
    assert.equal(
      await worker
        .get(ClassSessionEventsService)
        .consumeBatch(name, effect(name)),
      await f.prisma.classSessionEndEvent.count(),
    );
  } finally {
    await worker.close();
  }
});
