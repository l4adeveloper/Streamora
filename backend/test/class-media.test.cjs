const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
require("reflect-metadata");
const { createValidationPipe } = require("../dist/common/validation");
const { ApiError } = require("../dist/common/api-error");
const { readEnvironment } = require("../dist/config/environment");
const {
  JoinClassMediaDto,
  ClassMediaHeartbeatDto,
} = require("../dist/modules/class-media/class-media.dto");
const {
  sealMediaToken,
  openMediaToken,
} = require("../dist/modules/class-media/media-token");
const {
  ClassMediaService,
} = require("../dist/modules/class-media/class-media.service");
const { IvsService } = require("../dist/modules/class-media/ivs.service");
const {
  IvsEventsService,
  parseIvsEvent,
} = require("../dist/modules/class-media/ivs-events.service");
const {
  ClassMediaWorker,
} = require("../dist/modules/class-media/class-media.worker");
const SECRET = "test-only-secret-which-is-at-least-32-bytes";
const stageArn = "arn:aws:ivs:ap-northeast-1:123456789012:stage/test";
const config = {
  nodeEnv: "test",
  auth: { accessTokenSecret: SECRET },
  ivs: {
    enabled: true,
    region: "ap-northeast-1",
    tokenTtlSeconds: 60,
    workerEnabled: false,
    eventsQueueUrl:
      "https://sqs.ap-northeast-1.amazonaws.com/123456789012/ivs-events",
  },
};

test("T05 Swagger publishes three Bearer-protected media operations and explicit token response", async () => {
  const {
    exportClassMediaOpenApi,
  } = require("../scripts/export-class-media-openapi.cjs");
  const doc = await exportClassMediaOpenApi({ check: true });
  assert.equal(Object.values(doc.paths).flatMap(Object.values).length, 3);
  for (const path of Object.values(doc.paths))
    for (const operation of Object.values(path))
      assert.ok(operation.security.some((s) => s.accessToken));
  assert.equal(
    doc.components.schemas.JoinClassMediaDto.additionalProperties,
    false,
  );
  assert.ok(
    doc.components.schemas.JoinClassMediaResponseDto.properties
      .participantToken,
  );
  assert.ok(!JSON.stringify(doc).includes(SECRET));
});

test("T05 DTOs reject forged identities, role, stage ARN and malformed identifiers", async () => {
  const pipe = createValidationPipe();
  const valid = {
    participationId: randomUUID(),
    clientId: randomUUID(),
    requestId: randomUUID(),
  };
  assert.equal(
    (await pipe.transform(valid, { type: "body", metatype: JoinClassMediaDto }))
      .clientId,
    valid.clientId,
  );
  for (const body of [
    { ...valid, userId: randomUUID() },
    { ...valid, role: "ADMIN" },
    { ...valid, stageArn },
    { ...valid, clientId: "device" },
    { ...valid, deviceLabel: 1 },
  ])
    await assert.rejects(
      pipe.transform(body, { type: "body", metatype: JoinClassMediaDto }),
    );
  await assert.rejects(
    pipe.transform(
      {
        participationId: valid.participationId,
        clientId: valid.clientId,
        connected: "true",
        micEnabled: false,
        cameraEnabled: false,
      },
      { type: "body", metatype: ClassMediaHeartbeatDto },
    ),
  );
});
test("T05 env validates switches, short TTL, region-bound queue and fail-closed defaults", () => {
  const base = {
    ACCESS_TOKEN_SECRET: SECRET,
    DATABASE_URL: "postgresql://unused:unused@localhost/app",
  };
  assert.equal(readEnvironment(base).ivs.enabled, false);
  for (const change of [
    { IVS_ENABLED: "yes" },
    { IVS_TOKEN_TTL_SECONDS: "30" },
    { IVS_TOKEN_TTL_SECONDS: "120" },
    { IVS_WORKER_ENABLED: "true" },
    { IVS_EVENTS_QUEUE_URL: "http://private-queue.example/secret" },
  ])
    assert.throws(() => readEnvironment({ ...base, ...change }));
});
test("IVS and SQS use env access keys without a profile and reject incomplete credentials", async () => {
  const base = {
    ACCESS_TOKEN_SECRET: SECRET,
    DATABASE_URL: "postgresql://unused:unused@localhost/app",
    IVS_ENABLED: "true",
    AWS_REGION: "ap-northeast-1",
  };
  assert.equal(readEnvironment(base).ivs.credentials, undefined);
  assert.equal(
    readEnvironment({
      ...base,
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_SESSION_TOKEN: "",
    }).ivs.credentials,
    undefined,
  );
  for (const sessionToken of [undefined, "test-only-session-token"]) {
    const credentials = {
      accessKeyId: "test-only-access-key-id",
      secretAccessKey: "test-only-secret-access-key",
      ...(sessionToken ? { sessionToken } : {}),
    };
    const envConfig = readEnvironment({
      ...base,
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      ...(sessionToken ? { AWS_SESSION_TOKEN: sessionToken } : {}),
    });
    assert.deepEqual(envConfig.ivs.credentials, credentials);
    const ivs = new IvsService(envConfig);
    const events = new IvsEventsService({}, envConfig);
    try {
      for (const client of [ivs.client, events.sqs]) {
        const resolved = await client.config.credentials();
        assert.equal(resolved.accessKeyId, credentials.accessKeyId);
        assert.equal(resolved.secretAccessKey, credentials.secretAccessKey);
        assert.equal(resolved.sessionToken, sessionToken);
      }
    } finally {
      ivs.onModuleDestroy();
      await events.onModuleDestroy();
    }
  }
  for (const [change, missing] of [
    [{ AWS_ACCESS_KEY_ID: "test-only-access-key-id" }, "AWS_SECRET_ACCESS_KEY"],
    [
      { AWS_SECRET_ACCESS_KEY: "test-only-secret-access-key" },
      "AWS_ACCESS_KEY_ID",
    ],
    [{ AWS_SESSION_TOKEN: "test-only-session-token" }, "AWS_ACCESS_KEY_ID"],
  ]) {
    assert.throws(
      () => readEnvironment({ ...base, ...change }),
      (error) =>
        error.message.includes(missing) && !error.message.includes("test-only"),
    );
  }
});

test("IVS tokens are encrypted, authenticated and bound to a connection and server secret", () => {
  const sealed = sealMediaToken("private-ivs-token", SECRET, "connection-one");
  assert.ok(!sealed.includes("private-ivs-token"));
  assert.equal(
    openMediaToken(sealed, SECRET, "connection-one"),
    "private-ivs-token",
  );
  assert.throws(() => openMediaToken(sealed, SECRET, "connection-two"));
  assert.throws(() =>
    openMediaToken(sealed, SECRET + "changed", "connection-one"),
  );
  const bytes = Buffer.from(sealed, "base64url");
  bytes[30] ^= 1;
  assert.throws(() =>
    openMediaToken(bytes.toString("base64url"), SECRET, "connection-one"),
  );
});

function fixture() {
  const requests = new Map();
  let row = null,
    banned = false,
    authorized = true,
    tokens = 0;
  const actor = { userId: randomUUID(), authSessionId: randomUUID() };
  const sessionId = randomUUID(),
    dto = {
      participationId: randomUUID(),
      clientId: randomUUID(),
      requestId: randomUUID(),
    };
  const matches = (where) =>
    row &&
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object"
        ? value.not
          ? row[key] !== value.not
          : true
        : row[key] === value,
    );
  const db = {
    classMediaRequest: {
      findUnique: async ({ where }) => requests.get(where.id) ?? null,
      create: async ({ data }) => {
        requests.set(data.id, data);
        return data;
      },
    },
    $queryRaw: async () => [],
    sessionBan: { findFirst: async () => (banned ? { sessionId } : null) },
    user: { findUniqueOrThrow: async () => ({ fullName: "Tên từ server" }) },
    classMediaConnection: {
      findUnique: async () => row,
      findUniqueOrThrow: async () => ({ ...row }),
      findFirst: async ({ where }) => (matches(where) ? row : null),
      upsert: async ({ create, update }) => {
        row = row
          ? { ...row, ...update }
          : {
              state: "ISSUING",
              participantId: null,
              expiresAt: null,
              tokenCiphertext: null,
              ...create,
            };
        return { ...row };
      },
      updateMany: async ({ where, data }) => {
        if (!matches(where)) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
      update: async ({ data }) => {
        row = { ...row, ...data };
        return row;
      },
    },
  };
  const participants = {
    withParticipant: async (who, session, visit, work) => {
      if (
        !authorized ||
        who.userId !== actor.userId ||
        who.authSessionId !== actor.authSessionId ||
        session !== sessionId ||
        visit !== dto.participationId
      )
        throw new ApiError(403, "ADMISSION_REVOKED", "Denied");
      return work({ canManage: false }, db);
    },
  };
  const disconnects = [];
  const ivs = {
    available() {},
    token: async (_stage, userId, name) => {
      assert.equal(userId, actor.userId);
      assert.equal(name, "Tên từ server");
      tokens++;
      return {
        token: "private-token-" + tokens,
        participantId: "participant-" + tokens,
        expiresAt: new Date(Date.now() + 60000),
      };
    },
    disconnect: async (arn, id) => disconnects.push([arn, id]),
  };
  const service = new ClassMediaService(db, participants, ivs, config);
  service.room = async () => stageArn;
  return {
    service,
    db,
    ivs,
    actor,
    dto,
    sessionId,
    disconnects,
    get row() {
      return row;
    },
    get tokens() {
      return tokens;
    },
    deny() {
      authorized = false;
    },
    ban() {
      banned = true;
    },
  };
}

test("join retry recovers the same encrypted token without creating a phantom participant", async () => {
  const f = fixture();
  const first = await f.service.join(f.actor, f.sessionId, f.dto);
  const second = await f.service.join(f.actor, f.sessionId, f.dto);
  assert.equal(first.participantToken, second.participantToken);
  assert.equal(first.connectionId, second.connectionId);
  assert.equal(f.tokens, 1);
  assert.notEqual(f.row.tokenCiphertext, first.participantToken);
  await f.service.join(f.actor, f.sessionId, {
    ...f.dto,
    requestId: randomUUID(),
  });
  assert.equal(f.tokens, 2);
  assert.deepEqual(f.disconnects[0], [stageArn, first.participantId]);
});
test("join checks admission and ban before making any AWS call", async () => {
  const denied = fixture();
  denied.deny();
  await assert.rejects(
    denied.service.join(denied.actor, denied.sessionId, denied.dto),
    (e) =>
      e.code === "ADMISSION_REVOKED" ||
      e.getResponse().error.code === "ADMISSION_REVOKED",
  );
  assert.equal(denied.tokens, 0);
  const banned = fixture();
  banned.ban();
  await assert.rejects(
    banned.service.join(banned.actor, banned.sessionId, banned.dto),
    (e) => e.getStatus() === 403,
  );
  assert.equal(banned.tokens, 0);
});
test("late join retry and leave from an earlier generation cannot replace or close the new connection", async () => {
  const f = fixture();
  const old = await f.service.join(f.actor, f.sessionId, f.dto);
  const newer = await f.service.join(f.actor, f.sessionId, {
    ...f.dto,
    requestId: randomUUID(),
  });
  await f.service.leave(f.actor, f.sessionId, old.connectionId, old.requestId);
  assert.equal(f.row.state, "ACTIVE");
  assert.equal(f.row.requestId, newer.requestId);
  await assert.rejects(
    f.service.join(f.actor, f.sessionId, f.dto),
    (e) => e.getResponse().error.code === "STALE_MEDIA_REQUEST",
  );
  assert.equal(f.tokens, 2);
});
test("access revocation during AWS issuance prevents token disclosure and compensates externally", async () => {
  const f = fixture();
  const issue = f.ivs.token;
  f.ivs.token = async (...args) => {
    const result = await issue(...args);
    f.deny();
    return result;
  };
  await assert.rejects(
    f.service.join(f.actor, f.sessionId, f.dto),
    (e) => e.getStatus() === 403,
  );
  assert.deepEqual(f.disconnects, [[stageArn, "participant-1"]]);
  assert.equal(f.row.state, "REVOKING");
  assert.equal(f.row.tokenCiphertext, null);
});
test("heartbeat binds the auth session and connection; client presence does not become IVS presence", async () => {
  const f = fixture();
  const joined = await f.service.join(f.actor, f.sessionId, f.dto);
  const ping = {
    requestId: joined.requestId,
    participationId: f.dto.participationId,
    clientId: f.dto.clientId,
    connected: true,
    micEnabled: true,
    cameraEnabled: false,
  };
  await f.service.heartbeat(f.actor, f.sessionId, joined.connectionId, ping);
  assert.equal(f.row.connected, false);
  assert.equal(f.row.micEnabled, true);
  await assert.rejects(
    f.service.heartbeat(f.actor, f.sessionId, randomUUID(), ping),
    (e) => e.getStatus() === 403,
  );
  await assert.rejects(
    f.service.leave(
      { ...f.actor, authSessionId: randomUUID() },
      f.sessionId,
      joined.connectionId,
    ),
    (e) => e.getStatus() === 404,
  );
});
test("media leave hides the token immediately and server-side disconnect completes revocation", async () => {
  const f = fixture();
  const joined = await f.service.join(f.actor, f.sessionId, f.dto);
  await f.service.leave(
    f.actor,
    f.sessionId,
    joined.connectionId,
    joined.requestId,
  );
  assert.equal(f.row.tokenCiphertext, null);
  assert.equal(f.row.state, "REVOKING");
  await f.service.revoke({ ...f.row }, stageArn);
  assert.equal(f.row.state, "REVOKED");
  assert.deepEqual(f.disconnects, [[stageArn, joined.participantId]]);
});

test("IVS adapter reuses a tagged Stage, scopes tokens, and waits for composition before deleting", async () => {
  const adapter = new IvsService(config);
  const commands = [];
  adapter.client = {
    send: async (command) => {
      commands.push(command);
      switch (command.constructor.name) {
        case "ListStagesCommand":
          return {
            stages: [{ name: "streamora-test-session", arn: stageArn }],
          };
        case "GetStageCommand":
          return { stage: { tags: { streamoraSessionId: "session" } } };
        case "CreateParticipantTokenCommand":
          return {
            participantToken: {
              token: "token",
              participantId: "id",
              expirationTime: new Date(),
            },
          };
        case "ListCompositionsCommand":
          return { compositions: [{ state: "ACTIVE" }] };
      }
    },
    destroy() {},
  };
  assert.equal(await adapter.ensureStage("session"), stageArn);
  assert.ok(!commands.some((c) => c.constructor.name === "CreateStageCommand"));
  await adapter.token(stageArn, "server-user", "Server name");
  const token = commands.find(
    (c) => c.constructor.name === "CreateParticipantTokenCommand",
  ).input;
  assert.equal(token.stageArn, stageArn);
  assert.equal(token.userId, "server-user");
  assert.equal(token.duration, 1);
  assert.equal(await adapter.close(stageArn), false);
  assert.ok(!commands.some((c) => c.constructor.name === "DeleteStageCommand"));
  adapter.onModuleDestroy();
});

const envelope = (overrides) => ({
  id: randomUUID(),
  source: "aws.ivs",
  account: "123456789012",
  region: "ap-northeast-1",
  "detail-type": "IVS Composition State Change",
  time: new Date().toISOString(),
  resources: [stageArn],
  detail: { stage_arn: stageArn, event_name: "Session End" },
  ...overrides,
});
test("EventBridge parsing rejects wrong source/region, invalid times and malformed payloads", () => {
  assert.ok(parseIvsEvent(JSON.stringify(envelope()), "ap-northeast-1"));
  for (const input of [
    null,
    envelope({ source: "client" }),
    envelope({ region: "us-east-1" }),
    envelope({ time: "never" }),
    envelope({ detail: [] }),
    envelope({ resources: [1] }),
  ])
    assert.throws(() => parseIvsEvent(JSON.stringify(input), "ap-northeast-1"));
  assert.throws(() => parseIvsEvent("not-json", "ap-northeast-1"));
});
test("SQS acknowledges only durable inbox events; duplicates dedupe and T11 events remain pending", async () => {
  const saved = new Map();
  const order = [];
  const db = {
    classMediaRoom: { findUnique: async () => ({ sessionId: "session" }) },
    ivsEvent: {
      upsert: async ({ where, create }) => {
        if (!saved.has(where.id)) saved.set(where.id, create);
        order.push("persist");
      },
      findMany: async () => [],
    },
  };
  const service = new IvsEventsService(db, config);
  const event = envelope();
  service.sqs = {
    send: async (command) => {
      if (command.constructor.name === "ReceiveMessageCommand")
        return {
          Messages: [
            { Body: JSON.stringify(event), ReceiptHandle: "first" },
            { Body: JSON.stringify(event), ReceiptHandle: "duplicate" },
            { Body: "malformed", ReceiptHandle: "bad" },
          ],
        };
      order.push("ack");
      return {};
    },
    destroy() {},
  };
  await service.tick();
  assert.equal(saved.size, 1);
  assert.deepEqual(order, ["persist", "ack", "persist", "ack"]);
  assert.equal(saved.get(event.id).handledAt, undefined);
  await assert.rejects(
    service.ingest(JSON.stringify(envelope({ account: "999999999999" }))),
  );
  await service.onModuleDestroy();
});

test("media worker revokes denied participation without waiting for an EventBridge event", async () => {
  const calls = [];
  const row = {
    id: randomUUID(),
    userId: "user",
    authSessionId: "auth",
    sessionId: "session",
    participationId: "visit",
    state: "ACTIVE",
    lastSeenAt: new Date(),
    room: { stageArn },
  };
  const db = {
    classMediaConnection: {
      findMany: async () => [row],
      update: async () => {},
      updateMany: async () => ({ count: 1 }),
    },
    classMediaRoom: { findFirst: async () => null },
  };
  const media = {
    require: async () => {
      throw new ApiError(403, "BANNED", "Denied");
    },
    revoke: async (...args) => calls.push(args),
  };
  const worker = new ClassMediaWorker(db, media, config);
  await worker.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], stageArn);
});

test("T05 migration constraints run on isolated PostgreSQL without application data", async () => {
  const { PGlite } = require("@electric-sql/pglite");
  const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
  const { readFileSync, readdirSync } = require("node:fs");
  const { resolve } = require("node:path");
  const db = new PGlite({ extensions: { pg_trgm } });
  try {
    const migrations = resolve(__dirname, "../prisma/migrations");
    for (const entry of readdirSync(migrations, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name)))
      await db.exec(
        readFileSync(resolve(migrations, entry.name, "migration.sql"), "utf8"),
      );
    const session = randomUUID();
    const owner = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash,full_name) VALUES ($1,'sql-test@example.test','$argon2id$fixture','SQL test')",
      [owner],
    );
    await db.query(
      "INSERT INTO class_sessions(id,kind,created_by_id,title,join_code) VALUES ($1,'MEET',$2,'SQL test','123456789ABC')",
      [session, owner],
    );
    await db.query("INSERT INTO class_media_rooms(session_id) VALUES ($1)", [
      session,
    ]);
    await assert.rejects(
      db.query("INSERT INTO class_media_rooms(session_id) VALUES ($1)", [
        session,
      ]),
      (e) => e.code === "23505",
    );
    await assert.rejects(
      db.query(
        "UPDATE class_media_rooms SET state='INVALID' WHERE session_id=$1",
        [session],
      ),
      (e) => e.code === "23514",
    );
    await assert.rejects(
      db.query("INSERT INTO class_media_rooms(session_id) VALUES ($1)", [
        randomUUID(),
      ]),
      (e) => e.code === "23503",
    );
  } finally {
    await db.close();
  }
});

test("T05 HTTP routes enforce Bearer identity, runtime validation and no-store without AWS", async () => {
  const { Module } = require("@nestjs/common");
  const { NestFactory } = require("@nestjs/core");
  const { configureApplication } = require("../dist/app");
  const {
    ClassMediaController,
  } = require("../dist/modules/class-media/class-media.controller");
  const {
    AccessTokenGuard,
  } = require("../dist/common/auth/access-token.guard");
  const {
    AccessTokenService,
  } = require("../dist/modules/auth/access-token.service");
  const {
    SessionStore,
  } = require("../dist/modules/auth/session-store.service");
  const f = fixture();
  class Root {}
  Module({
    controllers: [ClassMediaController],
    providers: [
      { provide: ClassMediaService, useValue: f.service },
      AccessTokenGuard,
      {
        provide: AccessTokenService,
        useValue: {
          verify: (token) => {
            if (token !== "test-bearer") throw new Error("Invalid");
            return { userId: f.actor.userId, sessionId: f.actor.authSessionId };
          },
        },
      },
      {
        provide: SessionStore,
        useValue: {
          authenticate: async () => ({
            user: { id: f.actor.userId },
            sessionId: f.actor.authSessionId,
          }),
        },
      },
    ],
  })(Root);
  const app = await NestFactory.create(Root, { logger: false });
  configureApplication(
    app,
    { ...config, docsEnabled: false, webOrigin: "http://localhost:3000" },
    { requestLog: () => {} },
  );
  try {
    await app.listen(0, "127.0.0.1");
    const url = `${await app.getUrl()}/api/v1/sessions/${f.sessionId}/join`;
    const send = (body, bearer = true) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: "Bearer test-bearer" } : {}),
        },
        body: JSON.stringify(body),
      });
    assert.equal((await send(f.dto, false)).status, 401);
    assert.equal((await send({ ...f.dto, role: "ADMIN" })).status, 400);
    const response = await send(f.dto);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).participantId, "participant-1");
    f.deny();
    assert.equal((await send(f.dto)).status, 403);
  } finally {
    await app.close();
  }
});
