require("reflect-metadata");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} = require("@aws-sdk/client-dynamodb");
const { ChatStore } = require("../dist/modules/memberships/chat-store");
const {
  MembershipGateway,
} = require("../dist/modules/memberships/membership.gateway");
const { ApiError } = require("../dist/common/api-error");
let store, admin;
const groupId = randomUUID(),
  senderId = randomUUID();
function message(overrides = {}) {
  return {
    id: randomUUID(),
    groupId,
    senderId,
    senderName: "Người gửi",
    senderRole: "VIEWER",
    channel: "trò-chuyện-chung",
    clientId: randomUUID(),
    text: "Nội dung thử",
    replyToId: null,
    meetingId: null,
    createdAt: new Date().toISOString(),
    editedAt: null,
    ...overrides,
  };
}
before(async () => {
  // Tests can only create/delete a unique table on a loopback DynamoDB endpoint.
  const endpoint =
    process.env.CHAT_DYNAMODB_ENDPOINT || "http://127.0.0.1:8000";
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname));
  process.env.CHAT_DYNAMODB_ENDPOINT = endpoint;
  process.env.CHAT_DYNAMODB_TABLE = `streamora_chat_test_${randomUUID().replaceAll("-", "")}`;
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  store = new ChatStore();
  admin = new DynamoDBClient({
    region: "ap-southeast-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  await admin.send(
    new CreateTableCommand({
      TableName: store.table,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
    }),
  );
});
after(async () => {
  if (admin && store)
    await admin.send(new DeleteTableCommand({ TableName: store.table }));
  store?.client.destroy();
  admin?.destroy();
});
test("concurrent retries persist one message and one outbox event; changed payload conflicts", async () => {
  const m = message({ groupId: randomUUID() });
  const results = await Promise.all([
    store.save(m),
    store.save({ ...m, id: randomUUID() }),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal((await store.history(m.groupId, m.channel)).items.length, 1);
  assert.equal((await store.events(m.groupId, "2000")).length, 1);
  await assert.rejects(
    () => store.save({ ...m, text: "Changed" }),
    (e) => e.getStatus() === 409,
  );
});
test("history paginates stable equal timestamps and rejects cross-group/channel cursors", async () => {
  const id = randomUUID();
  for (let i = 0; i < 7; i++)
    await store.save(
      message({ groupId: id, createdAt: "2026-11-13T00:00:00.000Z" }),
    );
  const first = await store.history(id, "trò-chuyện-chung", undefined, 3);
  const second = await store.history(
    id,
    "trò-chuyện-chung",
    first.nextCursor,
    3,
  );
  const third = await store.history(
    id,
    "trò-chuyện-chung",
    second.nextCursor,
    3,
  );
  assert.equal(
    new Set([...first.items, ...second.items, ...third.items].map((x) => x.id))
      .size,
    7,
  );
  assert.equal(third.nextCursor, null);
  await assert.rejects(() =>
    store.history(randomUUID(), "trò-chuyện-chung", first.nextCursor),
  );
  await assert.rejects(() => store.history(id, "other", first.nextCursor));
});
test("search reaches old messages across channels; edited/deleted content stays out; scope is isolated", async () => {
  const id = randomUUID();
  const m = await store.save(
    message({ groupId: id, text: "CÂU HỎI về DynamoDB", channel: "tài-liệu" }),
  );
  await store.save(
    message({ groupId: randomUUID(), text: "CÂU HỎI về DynamoDB" }),
  );
  assert.equal((await store.search(id, "câu hỏi")).items.length, 1);
  await store.change(await store.get(id, m.id), "Nội dung đã sửa");
  assert.equal((await store.search(id, "DynamoDB")).items.length, 0);
  await store.change(await store.get(id, m.id));
  assert.equal((await store.search(id, "đã sửa")).items.length, 0);
  assert.equal(await store.get(id, m.id), null);
});
test("empty search page has a continuation; subsequent pages find older content", async () => {
  const id = randomUUID();
  await store.save(
    message({
      groupId: id,
      text: "needle",
      createdAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  for (let i = 0; i < 100; i++)
    await store.save(
      message({ groupId: id, createdAt: "2026-01-01T00:00:00.000Z" }),
    );
  const first = await store.search(id, "needle");
  assert.equal(first.items.length, 0);
  assert.ok(first.nextCursor);
  assert.equal(
    (await store.search(id, "needle", first.nextCursor)).items.length,
    1,
  );
});
test("threads persist titles and keep history separate from channels and other groups", async () => {
  const thread = await store.createThread(
    groupId,
    senderId,
    "Câu hỏi đầu tiên",
  );
  assert.equal((await store.getThread(groupId, thread.id)).title, thread.title);
  await store.requireThread(groupId, `thread:${thread.id}`);
  await assert.rejects(() =>
    store.requireThread(randomUUID(), `thread:${thread.id}`),
  );
  await store.save(message({ channel: `thread:${thread.id}` }));
  assert.equal(
    (await store.history(groupId, `thread:${thread.id}`)).items.length,
    1,
  );
  assert.equal(
    (await store.history(groupId, "trò-chuyện-chung")).items.length,
    0,
  );
});
function gateway(actorId = senderId) {
  const client = {
    id: randomUUID(),
    handshake: { auth: { accessToken: "test" } },
    data: {},
    rooms: new Set([`group:${groupId}`]),
  };
  const sessions = {
    authenticate: async () => ({
      user: { id: actorId, fullName: "Test" },
      sessionId: "test",
    }),
  };
  const access = {
    require: async (user, group) => {
      if (user === "revoked" || group !== groupId)
        throw new ApiError(403, "FORBIDDEN", "Denied");
      return { role: "VIEWER" };
    },
  };
  const prisma = {
    membershipChange: { findMany: async () => [] },
    classSessionChange: { findMany: async () => [] },
    groupChatChange: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
  };
  const g = new MembershipGateway(
    { verify: () => ({ userId: actorId, sessionId: "test" }) },
    sessions,
    access,
    prisma,
    store,
    { webOrigin: "http://localhost" },
  );
  const delivered = [];
  g.server = {
    sockets: new Map([[client.id, client]]),
    to: () => ({
      emit: (event, payload) => delivered.push({ event, payload }),
    }),
  };
  return { g, client, delivered };
}
test("gateway authorizes each write, prevents foreign edits/replies, and two instances receive durable events", async () => {
  const one = gateway(),
    two = gateway();
  const sent = await one.g.send(one.client, {
    groupId,
    channel: "trò-chuyện-chung",
    text: "Across servers",
    clientId: randomUUID(),
  });
  assert.equal(sent.ok, true);
  await two.g.flush();
  assert.ok(two.delivered.some((x) => x.payload.id === sent.id));
  const stranger = gateway(randomUUID());
  assert.equal(
    (
      await stranger.g.edit(stranger.client, {
        groupId,
        channel: "trò-chuyện-chung",
        id: sent.id,
        text: "Stolen",
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await one.g.send(one.client, {
        groupId,
        channel: "other",
        text: "Invalid reply",
        replyToId: sent.id,
      })
    ).ok,
    false,
  );
  const revoked = gateway("revoked");
  assert.equal(
    (await revoked.g.send(revoked.client, { groupId, text: "Denied" })).ok,
    false,
  );
  await revoked.g.flush();
  assert.equal(revoked.delivered.length, 0);
});
test("REST uses real auth, runtime validation and group permissions with isolated PostgreSQL", async () => {
  const { createMeetingFixture } = require("./meeting-fixture.cjs");
  const fixture = await createMeetingFixture();
  try {
    const owner = await fixture.account("Chat owner");
    const outsider = await fixture.account("Outsider");
    const created = await fixture.api(owner, "POST", "/groups", {
      name: "Chat test",
    });
    assert.equal(created.status, 201);
    const path = `/groups/${created.body.group.id}/chat`;
    assert.equal(
      (await fixture.api(null, "GET", `${path}/threads`)).status,
      401,
    );
    assert.equal(
      (await fixture.api(outsider, "GET", `${path}/search?q=test`)).status,
      403,
    );
    assert.equal(
      (await fixture.api(owner, "POST", `${path}/threads`, { title: "   " }))
        .status,
      400,
    );
    assert.equal(
      (
        await fixture.api(owner, "POST", `${path}/threads`, {
          title: "test",
          senderId: outsider.id,
        })
      ).status,
      400,
    );
    const result = await fixture.api(owner, "POST", `${path}/threads`, {
      title: "Hỏi về hệ thống",
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.thread.createdById, owner.id);
    assert.equal(
      (await fixture.api(owner, "GET", `${path}/threads`)).body.items.length,
      1,
    );
    assert.equal(
      (await fixture.api(owner, "GET", `${path}/messages?limit=101`)).status,
      400,
    );
    assert.equal(
      (await fixture.api(owner, "GET", `${path}/messages?cursor=invalid`))
        .status,
      400,
    );
  } finally {
    await fixture.cleanup();
  }
});
