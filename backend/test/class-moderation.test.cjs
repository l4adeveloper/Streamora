const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { io } = require("socket.io-client");
const { createMeetingFixture } = require("./meeting-fixture.cjs");
const { IvsService } = require("../dist/modules/class-media/ivs.service");
const {
  ClassMediaWorker,
} = require("../dist/modules/class-media/class-media.worker");

test(
  "T07 advisory mute, IVS publishing lock and session ban over REST and Socket.IO",
  { timeout: 60000 },
  async (t) => {
    t.mock.method(
      ClassMediaWorker.prototype,
      "onApplicationBootstrap",
      () => {},
    );
    const stage = (id) => `arn:aws:ivs:ap-northeast-1:123456789012:stage/${id}`;
    t.mock.method(IvsService.prototype, "ensureStage", async (id) => stage(id));
    const token = t.mock.method(IvsService.prototype, "token", async () => ({
      token: randomUUID(),
      participantId: randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    }));
    let failDisconnect = false;
    const disconnect = t.mock.method(
      IvsService.prototype,
      "disconnect",
      async () => {
        if (failDisconnect) throw new Error("Temporary IVS failure");
      },
    );
    t.mock.method(IvsService.prototype, "presence", async () => ({
      sessionId: null,
      connectedIds: new Set(),
    }));
    const origin = "http://127.0.0.1:3000";
    const f = await createMeetingFixture(origin, {
      ivs: { enabled: true, region: "ap-northeast-1", tokenTtlSeconds: 60 },
    });
    const sockets = [];
    t.after(async () => {
      sockets.forEach((socket) => socket.disconnect());
      await f.cleanup();
    });
    const request = async (actor, method, path, body, status = 200, key) => {
      const result = await f.api(actor, method, path, body, key);
      assert.equal(result.status, status, JSON.stringify(result.body));
      return result.body;
    };
    const watch = async (actor, sessionId) => {
      const socket = io(`${f.base.replace(/\/api\/v1$/, "")}/classroom`, {
        auth: { accessToken: actor.token },
        transports: ["websocket"],
        reconnection: false,
        extraHeaders: { Origin: origin },
      });
      sockets.push(socket);
      const signal = AbortSignal.timeout(8000);
      await once(socket, "connect", { signal });
      const snapshot = await socket
        .timeout(5000)
        .emitWithAck("session:watch", { sessionId });
      assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
      return socket;
    };
    const owner = await f.account("Owner");
    const host = await f.account("Host");
    const viewer = await f.account("Viewer");
    const otherViewer = await f.account("Other viewer");
    const group = await f.prisma.group.create({
      data: {
        name: "T07",
        ownerId: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: host.id, role: "HOST" },
            { userId: viewer.id, role: "VIEWER" },
            { userId: otherViewer.id, role: "VIEWER" },
          ],
        },
      },
    });
    async function openSession() {
      const { session } = await request(
        owner,
        "POST",
        `/groups/${group.id}/sessions`,
        {
          memberAdmission: "DIRECT",
        },
        201,
      );
      const path = `/sessions/${session.id}`;
      await request(owner, "POST", `${path}/start`, {}, 200, randomUUID());
      const { participation } = await request(
        viewer,
        "POST",
        `${path}/enter`,
        {},
        200,
        randomUUID(),
      );
      return {
        path,
        id: session.id,
        joinBody: {
          participationId: participation.id,
          clientId: randomUUID(),
          requestId: randomUUID(),
        },
      };
    }
    const room = await openSession();
    const otherRoom = await openSession();
    const client = await watch(viewer, room.id);
    const listener = await watch(otherViewer, room.id);
    const otherMutes = [];
    listener.on("moderation.mute", (event) => otherMutes.push(event));
    const mutePath = `${room.path}/participants/${viewer.id}/mute`;
    const bans = `${room.path}/bans`;
    const banPath = `${bans}/${viewer.id}`;
    const joinPath = `${room.path}/join`;
    const media = await request(viewer, "POST", joinPath, room.joinBody);
    const otherMedia = await request(
      viewer,
      "POST",
      `${otherRoom.path}/join`,
      otherRoom.joinBody,
    );
    const anotherTab = await request(viewer, "POST", joinPath, {
      ...room.joinBody,
      clientId: randomUUID(),
      requestId: randomUUID(),
    });

    await request(viewer, "POST", mutePath, { lock: true }, 403);
    await request(viewer, "PUT", banPath, {}, 403);
    await request(viewer, "DELETE", banPath, undefined, 403);
    await request(viewer, "GET", bans, undefined, 403);
    await request(host, "POST", mutePath, { lock: "true" }, 400);
    await request(host, "PUT", `${bans}/${owner.id}`, {}, 409);
    const advisory = once(client, "moderation.mute", {
      signal: AbortSignal.timeout(8000),
    });
    assert.deepEqual(await request(host, "POST", mutePath, {}), {
      userId: viewer.id,
      muted: true,
      locked: false,
    });
    assert.equal((await advisory)[0].sessionId, room.id);
    assert.equal(disconnect.mock.callCount(), 0);
    assert.equal(
      (await request(viewer, "POST", joinPath, room.joinBody)).participantId,
      media.participantId,
    );

    await request(host, "POST", mutePath, { lock: true });
    assert.deepEqual(
      new Set(
        disconnect.mock.calls.map(({ arguments: args }) => args.join("/")),
      ),
      new Set(
        [media, anotherTab].map(
          ({ participantId }) => `${stage(room.id)}/${participantId}`,
        ),
      ),
    );
    assert.equal(
      (await request(viewer, "GET", `${room.path}/admission`)).micLocked,
      true,
    );
    await request(viewer, "POST", joinPath, room.joinBody, 409);
    const listenBody = { ...room.joinBody, requestId: randomUUID() };
    const listen = await request(viewer, "POST", joinPath, listenBody);
    assert.deepEqual(listen.capabilities, ["SUBSCRIBE"]);
    assert.equal(token.mock.calls.at(-1).arguments[4], false);
    const blockedShare = await request(
      viewer, "POST", joinPath,
      { ...listenBody, requestId: randomUUID(), source: "SCREEN" }, 403,
    );
    assert.equal(blockedShare.error.code, "MEDIA_PUBLISH_LOCKED");
    await request(host, "POST", mutePath, { lock: true });
    assert.equal(
      (await request(viewer, "POST", joinPath, listenBody)).participantId,
      listen.participantId,
    );
    await request(host, "POST", mutePath, { lock: false });
    const restored = await request(viewer, "POST", joinPath, {
      ...listenBody,
      requestId: randomUUID(),
    });
    assert.deepEqual(restored.capabilities, ["PUBLISH", "SUBSCRIBE"]);

    const kicked = once(client, "session.access-revoked", {
      signal: AbortSignal.timeout(8000),
    });
    const closed = once(client, "disconnect", {
      signal: AbortSignal.timeout(8000),
    });
    failDisconnect = true;
    const failure = await request(
      host,
      "PUT",
      banPath,
      { reason: "Private reason" },
      503,
    );
    assert.equal(failure.error.code, "MEDIA_REVOCATION_PENDING");
    assert.deepEqual((await kicked)[0], {
      sessionId: room.id,
      reason: "BANNED",
    });
    await closed;
    const denied = await request(
      viewer,
      "POST",
      joinPath,
      { ...listenBody, requestId: randomUUID() },
      403,
    );
    assert.equal(denied.error.code, "BANNED");
    failDisconnect = false;
    assert.deepEqual(await request(host, "PUT", banPath, { reason: "Retry" }), {
      userId: viewer.id,
      banned: true,
    });
    assert.deepEqual(disconnect.mock.calls.at(-1).arguments, [
      stage(room.id),
      restored.participantId,
    ]);
    const first = await request(host, "GET", bans);
    assert.equal(first.items[0].reason, "Private reason");
    await request(owner, "PUT", `${bans}/${otherViewer.id}`, {});
    const page = await request(host, "GET", `${bans}?limit=1`);
    assert.ok(page.nextCursor);
    const next = await request(
      host,
      "GET",
      `${bans}?limit=1&cursor=${page.nextCursor}`,
    );
    assert.notEqual(next.items[0].userId, page.items[0].userId);
    assert.equal(next.nextCursor, null);
    assert.deepEqual(otherMutes, []);
    await request(host, "DELETE", banPath, undefined, 204);
    assert.equal(
      (await request(viewer, "GET", `${room.path}/admission`)).participation
        .leaveReason,
      "ACCESS_REVOKED",
    );
    await request(
      viewer,
      "POST",
      joinPath,
      { ...listenBody, requestId: randomUUID() },
      403,
    );
    const reentry = await request(
      viewer,
      "POST",
      `${room.path}/enter`,
      {},
      200,
      randomUUID(),
    );
    const joined = await request(viewer, "POST", joinPath, {
      ...listenBody,
      participationId: reentry.participation.id,
      requestId: randomUUID(),
    });
    assert.deepEqual(joined.capabilities, ["PUBLISH", "SUBSCRIBE"]);
    assert.equal(
      (
        await request(
          viewer,
          "POST",
          `${otherRoom.path}/join`,
          otherRoom.joinBody,
        )
      ).participantId,
      otherMedia.participantId,
    );
  },
);
