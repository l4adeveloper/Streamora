const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { createServer } = require("node:http");
const jwt = require("jsonwebtoken");
const { io } = require("socket.io-client");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../../dist/modules/app.module");
const { configureApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const {
  MembershipGateway,
} = require("../../dist/modules/memberships/membership.gateway");
const {
  MembershipMediaService,
} = require("../../dist/modules/memberships/membership-media.service");
const { createTestDatabase } = require("./database-fixture.cjs");
let fixture,
  prisma,
  app,
  second,
  base,
  otherBase,
  owner,
  viewer,
  host,
  outsider,
  admin,
  config;
const origin = "http://127.0.0.1:3000";
const password = "Membership-test-password-123!";

async function api(actor, method, path, body, target = base) {
  const response = await fetch(`${target}/api/v1${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    headers: response.headers,
  };
}
async function account(name) {
  const email = `${name}-${randomUUID()}@example.test`;
  assert.equal(
    (
      await api(null, "POST", "/auth/register", {
        email,
        password,
        fullName: `Thành viên ${name}`,
      })
    ).status,
    201,
  );
  const response = await api(null, "POST", "/auth/login", { email, password });
  return { ...response.body.user, token: response.body.accessToken };
}
async function group() {
  const response = await api(owner, "POST", "/groups", {
    name: `T03 ${randomUUID()}`,
  });
  assert.equal(response.status, 201);
  return response.body.group.id;
}
async function member(groupId, actor, role = "VIEWER") {
  return api(owner, "POST", `/groups/${groupId}/members`, {
    userId: actor.id,
    role,
  });
}
async function start() {
  const server = await NestFactory.create(AppModule.forRoot(config), {
    logger: false,
  });
  configureApplication(server, config, { requestLog: () => {} });
  await server.listen(0, "127.0.0.1");
  return server;
}
before(
  async () => {
    fixture = await createTestDatabase();
    config = {
      ...fixture.config,
      databaseUrl: fixture.url,
      nodeEnv: "test",
      webOrigin: origin,
      auth: {
        ...fixture.config.auth,
        accessTokenSecret: randomBytes(48).toString("base64url"),
      },
    };
    prisma = new PrismaService(fixture.url);
    await prisma.onModuleInit();
    app = await start();
    base = await app.getUrl();
    second = await start();
    otherBase = await second.getUrl();
    owner = await account("owner");
    viewer = await account("viewer");
    host = await account("host");
    outsider = await account("outsider");
    admin = await account("admin");
    await prisma.user.update({
      where: { id: admin.id },
      data: { globalRole: "ADMIN" },
    });
  },
  { timeout: 120000 },
);
after(async () => {
  try {
    if (app) await app.close();
    if (second) await second.close();
    if (prisma) await prisma.onModuleDestroy();
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test("exact email lookup, role matrix, owner protection and live DB global ADMIN", async () => {
  const id = await group();
  assert.equal((await member(id, viewer)).status, 201);
  assert.equal((await member(id, host, "HOST")).status, 201);
  const path = `/groups/${id}`;
  for (const actor of [viewer, host, outsider]) {
    assert.equal(
      (
        await api(
          actor,
          "GET",
          `/users/lookup?groupId=${id}&email=${viewer.email}`,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await api(actor, "POST", `${path}/members`, {
          userId: outsider.id,
          role: "HOST",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await api(actor, "PATCH", `${path}/members/${viewer.id}`, {
          role: "HOST",
        })
      ).status,
      403,
    );
    assert.equal(
      (await api(actor, "DELETE", `${path}/members/${viewer.id}`)).status,
      403,
    );
  }
  const found = await api(
    owner,
    "GET",
    `/users/lookup?${new URLSearchParams({ groupId: id, email: ` ${viewer.email.toUpperCase()} ` })}`,
  );
  assert.deepEqual(found.body.user, {
    id: viewer.id,
    email: viewer.email,
    fullName: viewer.fullName,
  });
  assert.equal(
    (
      await api(
        owner,
        "GET",
        `/users/lookup?groupId=${id}&email=missing@example.test`,
      )
    ).body.user,
    null,
  );
  assert.equal(
    (await api(owner, "GET", `/users/lookup?groupId=${id}&email=viewer`))
      .status,
    400,
  );
  assert.equal((await api(null, "GET", `${path}/members`)).status, 401);
  assert.equal((await api(outsider, "GET", `${path}/members`)).status, 403);
  const listed = await api(viewer, "GET", `${path}/members`);
  assert.equal(listed.status, 200);
  assert.equal(
    listed.body.items.find((item) => item.userId === owner.id).role,
    "OWNER",
  );
  assert.equal(
    listed.body.items.find((item) => item.userId === host.id).email,
    host.email,
  );
  assert.match(listed.headers.get("cache-control"), /no-store/);
  assert.equal(
    (await api(viewer, "GET", `${path}/permissions/me`)).body.canHost,
    false,
  );
  assert.equal(
    (await api(host, "GET", `${path}/permissions/me`)).body.canHost,
    true,
  );
  assert.equal(
    (await api(admin, "GET", `${path}/permissions/me`)).body.role,
    "ADMIN",
  );
  assert.equal(
    (
      await api(admin, "PATCH", `${path}/members/${viewer.id}`, {
        role: "HOST",
      })
    ).status,
    200,
  );
  assert.equal(
    (await api(viewer, "GET", `${path}/permissions/me`)).body.canHost,
    true,
  );
  for (const actor of [owner, admin]) {
    const results = await Promise.all([
      api(actor, "DELETE", `${path}/members/${owner.id}`),
      api(actor, "PATCH", `${path}/members/${owner.id}`, { role: "VIEWER" }),
    ]);
    assert.ok(
      results.every(
        (result) =>
          result.status === 409 && result.body.error.code === "OWNER_PROTECTED",
      ),
    );
  }
  for (const role of ["OWNER", "ADMIN"])
    assert.equal(
      (
        await api(owner, "POST", `${path}/members`, {
          userId: outsider.id,
          role,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await api(owner, "POST", `${path}/members`, {
        userId: randomUUID(),
        role: "VIEWER",
      })
    ).body.error.code,
    "USER_NOT_FOUND",
  );
  const concurrent = await Promise.all([
    member(id, outsider),
    member(id, outsider),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.status).sort(),
    [201, 409],
  );
  const ownerRow = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId: owner.id, groupId: id } },
  });
  assert.equal(ownerRow.role, "OWNER");
});

test("member search and stable opaque pagination stay scoped to group and filter", async () => {
  const id = await group(),
    otherId = await group();
  await member(id, viewer);
  await member(id, host);
  const path = `/groups/${id}/members`;
  const first = await api(owner, "GET", `${path}?limit=1`);
  const secondPage = await api(
    owner,
    "GET",
    `${path}?limit=1&cursor=${first.body.nextCursor}`,
  );
  const third = await api(
    owner,
    "GET",
    `${path}?limit=1&cursor=${secondPage.body.nextCursor}`,
  );
  assert.equal(
    new Set(
      [...first.body.items, ...secondPage.body.items, ...third.body.items].map(
        (item) => item.userId,
      ),
    ).size,
    3,
  );
  assert.equal(third.body.nextCursor, null);
  assert.equal(
    (
      await api(
        owner,
        "GET",
        `/groups/${otherId}/members?cursor=${first.body.nextCursor}`,
      )
    ).status,
    400,
  );
  assert.equal(
    (await api(owner, "GET", `${path}?q=other&cursor=${first.body.nextCursor}`))
      .status,
    400,
  );
  assert.equal(
    (
      await api(
        owner,
        "GET",
        `${path}?q=${encodeURIComponent(viewer.email.toUpperCase())}`,
      )
    ).body.items[0].userId,
    viewer.id,
  );
  assert.equal(
    (await api(owner, "GET", `${path}?q=HOST`)).body.items[0].userId,
    host.id,
  );
  for (const query of ["cursor=bad", "limit=101", "limit=0", "cursor=e30"])
    assert.equal((await api(owner, "GET", `${path}?${query}`)).status, 400);
  await api(owner, "DELETE", `/groups/${id}`);
  assert.equal((await api(admin, "GET", path)).status, 404);
});

test("deletion revokes stale bearer access to rooms, files and recording permissions across instances", async () => {
  const id = await group();
  await member(id, viewer);
  const roomResponse = await api(owner, "POST", "/rooms", {
    name: "Lớp T03",
    groupId: id,
  });
  assert.equal(roomResponse.status, 201);
  const room = roomResponse.body.data;
  assert.equal((await api(viewer, "GET", `/rooms/${room.id}`)).status, 200);
  assert.equal(
    (await api(outsider, "GET", `/rooms/${room.id}?groupId=${id}`)).status,
    403,
  );
  assert.equal(
    (await api(viewer, "POST", "/rooms", { name: "Không được", groupId: id }))
      .status,
    403,
  );
  assert.equal((await api(viewer, "GET", `/files?groupId=${id}`)).status, 200);
  assert.equal(
    (await api(owner, "DELETE", `/groups/${id}/members/${viewer.id}`)).status,
    204,
  );
  for (const endpoint of [
    `/groups/${id}/permissions/me`,
    `/groups/${id}/members`,
    `/rooms/${room.id}`,
    `/files?groupId=${id}`,
  ])
    assert.equal(
      (await api(viewer, "GET", endpoint, undefined, otherBase)).status,
      403,
    );
  assert.equal((await api(viewer, "GET", "/users/me")).status, 200);
});

async function connect(actor, target = otherBase) {
  const socket = io(`${target}/classroom`, {
    auth: { accessToken: actor?.token },
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: { Origin: origin },
  });
  await once(socket, "connect");
  return socket;
}
const ack = (socket, event, body) =>
  new Promise((resolve, reject) =>
    socket
      .timeout(5000)
      .emit(event, body, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
  );
async function waitUntil(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("T03-07 only notifies the affected user, evicts online sockets and rejects rejoin and send", async () => {
  const id = await group();
  await member(id, viewer);
  await member(id, host, "HOST");
  const learner = await connect(viewer),
    teacher = await connect(host),
    observer = await connect(owner),
    stranger = await connect(outsider);
  const events = [],
    foreignEvents = [],
    messages = [];
  learner.on("membership.changed", (value) => events.push(value));
  learner.on("chat:message", (value) => messages.push(value));
  observer.on("membership.changed", (value) => foreignEvents.push(value));
  try {
    assert.equal(
      (await ack(learner, "channel:join", { groupId: id })).ok,
      true,
    );
    assert.equal(
      (await ack(teacher, "channel:join", { groupId: id })).ok,
      true,
    );
    assert.equal(
      (await ack(stranger, "channel:join", { groupId: id })).ok,
      false,
    );
    assert.equal(
      (await ack(teacher, "chat:send", { groupId: id, text: "Trước khi xóa" }))
        .ok,
      true,
    );
    await waitUntil(() => messages.length === 1);
    assert.equal(
      (
        await api(owner, "PATCH", `/groups/${id}/members/${viewer.id}`, {
          role: "HOST",
        })
      ).status,
      200,
    );
    await waitUntil(() => events.some((event) => event.role === "HOST"));
    assert.equal(
      (await api(owner, "DELETE", `/groups/${id}/members/${viewer.id}`)).status,
      204,
    );
    assert.equal(
      (await ack(teacher, "chat:send", { groupId: id, text: "Sau khi xóa" }))
        .ok,
      true,
    );
    await waitUntil(() => events.some((event) => event.removed));
    assert.equal(messages.length, 1);
    assert.equal(foreignEvents.length, 0);
    const change = events.find((event) => event.removed);
    assert.equal(change.role, null);
    assert.match(change.version, /^\d+$/);
    assert.equal(
      (await ack(learner, "channel:join", { groupId: id })).ok,
      false,
    );
    assert.equal(
      (
        await ack(learner, "chat:send", {
          groupId: id,
          text: "Không còn quyền",
        })
      ).ok,
      false,
    );
    const serverSocket = [
      ...second.get(MembershipGateway).server.sockets.values(),
    ].find((socket) => socket.id === learner.id);
    assert.equal(serverSocket.rooms.has(`group:${id}`), false);
  } finally {
    for (const socket of [learner, teacher, observer, stranger])
      socket.disconnect();
  }
});

test("lookup quota is atomic and shared by API instances", async () => {
  const id = await group();
  await prisma.membershipLookupWindow.deleteMany({
    where: { userId: owner.id },
  });
  const responses = await Promise.all(
    Array.from({ length: 35 }, (_, index) =>
      api(
        owner,
        "GET",
        `/users/lookup?groupId=${id}&email=${viewer.email}`,
        undefined,
        index % 2 ? base : otherBase,
      ),
    ),
  );
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    30,
  );
  assert.equal(
    responses.filter((response) => response.status === 429).length,
    5,
  );
});

test("LiveKit updates only registered rooms, retries failures durably and removes using the current DB permission", async () => {
  const id = await group();
  await member(id, viewer, "HOST");
  const room = (
    await api(owner, "POST", "/rooms", { name: "Media T03", groupId: id })
  ).body.data;
  const registered = await prisma.groupRoom.findUnique({
    where: { id: room.id },
  });
  const saved = Object.fromEntries(
    ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  const requests = [];
  let fail = false;
  const mediaServer = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const claims = jwt.verify(
      request.headers.authorization.slice(7),
      "t03-media-test-secret",
    );
    assert.equal(claims.iss, "t03-media-key");
    assert.deepEqual(claims.video, { roomAdmin: true, room: body.room });
    requests.push({ method: request.url.split("/").at(-1), ...body });
    response.writeHead(fail ? 503 : 200, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify(
        fail
          ? { code: "unavailable", msg: "Temporary test outage" }
          : { identity: body.identity },
      ),
    );
  });
  await new Promise((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  process.env.LIVEKIT_URL = `http://127.0.0.1:${mediaServer.address().port}`;
  process.env.LIVEKIT_API_KEY = "t03-media-key";
  process.env.LIVEKIT_API_SECRET = "t03-media-test-secret";
  const media = app.get(MembershipMediaService);
  try {
    await media.synchronize(id, viewer.id);
    assert.ok(
      requests.some(
        (request) =>
          request.room === registered.roomName &&
          request.identity === viewer.id &&
          request.method === "UpdateParticipant",
      ),
    );
    await api(owner, "PATCH", `/groups/${id}/members/${viewer.id}`, {
      role: "VIEWER",
    });
    await media.synchronize(id, viewer.id);
    const update = requests
      .filter(
        (request) =>
          request.room === registered.roomName &&
          request.method === "UpdateParticipant",
      )
      .at(-1);
    assert.deepEqual(update.permission.canPublishSources, [
      "CAMERA",
      "MICROPHONE",
    ]);
    fail = true;
    await api(owner, "DELETE", `/groups/${id}/members/${viewer.id}`);
    const change = await prisma.membershipChange.findFirst({
      where: { groupId: id, userId: viewer.id, removed: true },
      orderBy: { version: "desc" },
    });
    await app.get(MembershipGateway).flushMedia();
    await waitUntil(
      async () =>
        (
          await prisma.membershipChange.findUnique({
            where: { version: change.version },
          })
        ).attempts > 0,
      10000,
    );
    assert.equal(
      (
        await prisma.membershipChange.findUnique({
          where: { version: change.version },
        })
      ).mediaSyncedAt,
      null,
    );
    assert.equal(
      (await api(viewer, "GET", `/groups/${id}/permissions/me`)).status,
      403,
    );
    fail = false;
    await prisma.membershipChange.update({
      where: { version: change.version },
      data: { nextAttemptAt: new Date(0) },
    });
    await waitUntil(
      async () =>
        Boolean(
          (
            await prisma.membershipChange.findUnique({
              where: { version: change.version },
            })
          ).mediaSyncedAt,
        ),
      10000,
    );
    assert.ok(
      requests.some(
        (request) =>
          request.room === registered.roomName &&
          request.identity === viewer.id &&
          request.method === "RemoveParticipant",
      ),
    );
    assert.ok(!requests.some((request) => request.room === id));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => mediaServer.close(resolve));
  }
});

test("socket handshake is authenticated and auth refresh cannot switch the connected user", async () => {
  const anonymous = io(`${base}/classroom`, {
    transports: ["websocket"],
    reconnection: false,
  });
  try {
    assert.match(
      (await once(anonymous, "connect_error"))[0].message,
      /UNAUTHENTICATED/,
    );
  } finally {
    anonymous.disconnect();
  }
  const socket = await connect(owner);
  try {
    assert.equal(
      (await ack(socket, "auth:refresh", { accessToken: owner.token })).ok,
      true,
    );
    const disconnected = once(socket, "disconnect");
    socket.emit("auth:refresh", { accessToken: viewer.token });
    await disconnected;
  } finally {
    socket.disconnect();
  }
});
