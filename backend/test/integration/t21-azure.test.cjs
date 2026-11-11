const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const { io } = require("socket.io-client");
const {
  createClassSessionApiFixture,
  expect,
} = require("./class-session-api-fixture.cjs");
const {
  MembershipGateway,
} = require("../../dist/modules/memberships/membership.gateway");

const endpoint = process.env.T21_AZURE_URL;
const secretId = process.env.T21_AZURE_SECRET_ID;
const origin = "http://127.0.0.1:3000";
const ack = (socket, event, data) =>
  socket.timeout(10000).emitWithAck(event, data);

test(
  "T21 Azure carries chat, session and membership events across two API instances",
  {
    skip:
      !endpoint &&
      !secretId &&
      "Requires a dedicated Azure Socket.IO resource and AWS secret",
    timeout: 120000,
  },
  async () => {
    assert.ok(
      endpoint && secretId,
      "Set both T21_AZURE_URL and T21_AZURE_SECRET_ID",
    );
    const f = await createClassSessionApiFixture({
      azureRealtime: {
        secretId,
        region: process.env.AWS_REGION ?? "ap-northeast-1",
      },
    });
    const sockets = new Set();
    const signal = AbortSignal.timeout(40000);
    async function connect(actor) {
      const socket = io(`${endpoint.replace(/\/$/, "")}/classroom`, {
        path: "/clients/socketio/hubs/classroom",
        auth: { accessToken: actor.token },
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
        reconnection: false,
        forceNew: true,
        autoConnect: false,
      });
      sockets.add(socket);
      const connected = Promise.race([
        once(socket, "connect", { signal }),
        once(socket, "connect_error", { signal }).then(([error]) => {
          throw error;
        }),
      ]);
      socket.connect();
      await connected;
      return socket;
    }
    const onInstance = (app, socket) =>
      app.get(MembershipGateway).server.sockets.has(socket.id);
    const sessionEvent = (socket, name) =>
      once(socket, name, { signal }).then(([payload]) => payload);
    try {
      const lesson = await f.lesson({ live: false });
      const writer = await connect(f.owner);
      const writerApp = onInstance(f.app, writer) ? f.app : f.second;
      const readerApp = writerApp === f.app ? f.second : f.app;
      assert.ok(onInstance(writerApp, writer));
      let reader;
      for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = await connect(f.viewer);
        if (onInstance(readerApp, candidate)) {
          reader = candidate;
          break;
        }
        candidate.disconnect();
      }
      assert.ok(
        reader,
        "Azure did not route a client to the second API instance",
      );
      for (const socket of [writer, reader]) {
        assert.equal(
          (await ack(socket, "channel:join", { groupId: lesson.groupId })).ok,
          true,
        );
        assert.equal(
          (await ack(socket, "session:watch", { sessionId: lesson.id })).ok,
          true,
        );
      }
      const chat = Promise.all(
        [writer, reader].map((socket) => sessionEvent(socket, "chat:message")),
      );
      assert.equal(
        (
          await ack(writer, "chat:send", {
            groupId: lesson.groupId,
            text: "T21",
          })
        ).ok,
        true,
      );
      const [sent, received] = await chat;
      assert.equal(received.id, sent.id);
      assert.equal(received.text, "T21");

      const changed = Promise.all(
        [writer, reader].map((socket) =>
          sessionEvent(socket, "session.changed"),
        ),
      );
      expect(
        await f.api(f.owner, "POST", `/sessions/${lesson.id}/start`, {}),
        200,
      );
      assert.ok(
        (await changed).every((event) => event.sessionId === lesson.id),
      );

      const membership = sessionEvent(reader, "membership.changed");
      expect(
        await f.api(
          f.owner,
          "PATCH",
          `/groups/${lesson.groupId}/members/${f.viewer.id}`,
          { role: "HOST" },
        ),
        200,
      );
      assert.equal((await membership).role, "HOST");
      const disconnected = once(reader, "disconnect", { signal });
      expect(
        await f.api(
          f.owner,
          "DELETE",
          `/groups/${lesson.groupId}/members/${f.viewer.id}`,
        ),
        204,
      );
      await disconnected;
      const rejoined = await connect(f.viewer);
      assert.equal(
        (await ack(rejoined, "channel:join", { groupId: lesson.groupId })).ok,
        false,
      );
      assert.equal(
        (await ack(rejoined, "session:watch", { sessionId: lesson.id })).ok,
        false,
      );
    } finally {
      for (const socket of sockets) socket.disconnect();
      await f.cleanup();
    }
  },
);
