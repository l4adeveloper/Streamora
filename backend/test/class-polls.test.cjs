const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { setTimeout: pause } = require("node:timers/promises");
const { io } = require("socket.io-client");
const { createMeetingFixture } = require("./meeting-fixture.cjs");

test(
  "T09 validates access, tallies concurrent votes, restores private choices and broadcasts public poll versions",
  { timeout: 60000 },
  async (t) => {
    const origin = "http://127.0.0.1:3000";
    const f = await createMeetingFixture(origin);
    const sockets = [];
    t.after(async () => {
      sockets.forEach((socket) => socket.disconnect());
      await f.cleanup();
    });

    const [owner, host, viewer, other, guest] = await Promise.all(
      ["Owner", "Host", "Viewer", "Other viewer", "Outside guest"].map((name) =>
        f.account(name),
      ),
    );
    const group = await f.prisma.group.create({
      data: {
        name: "T09",
        ownerId: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: host.id, role: "HOST" },
            { userId: viewer.id, role: "VIEWER" },
            { userId: other.id, role: "VIEWER" },
          ],
        },
      },
    });
    const expect = async (request, status, code) => {
      const result = await request;
      assert.equal(result.status, status, JSON.stringify(result.body));
      if (code) assert.equal(result.body.error.code, code);
      return result.body;
    };
    const call = (actor, method, path, body, status = 200, code) =>
      expect(f.api(actor, method, path, body, randomUUID()), status, code);

    const { session } = await call(
      owner,
      "POST",
      `/groups/${group.id}/sessions`,
      {
        allowGuests: true,
        memberAdmission: "DIRECT",
      },
      201,
    );
    const room = `/sessions/${session.id}`;
    const polls = `${room}/polls`;
    const body = {
      question: "  Học phần tiếp theo? ",
      options: [{ text: "A" }, { text: "B" }],
    };
    await call(host, "POST", polls, body, 409, "SESSION_NOT_LIVE");
    await call(host, "POST", `${room}/start`, {});
    const { request } = await call(guest, "POST", `${room}/join-requests`, {});
    await call(owner, "PATCH", `${room}/join-requests/${request.id}`, {
      decision: "ACCEPT",
    });
    await call(guest, "POST", `${room}/enter`, {});

    async function watch(actor) {
      const socket = io(`${f.base.replace(/\/api\/v1$/, "")}/classroom`, {
        auth: { accessToken: actor.token },
        transports: ["websocket"],
        reconnection: false,
        extraHeaders: { Origin: origin },
      });
      sockets.push(socket);
      const updates = [];
      socket.on("poll.updated", (event) => updates.push(event));
      await once(socket, "connect", { signal: AbortSignal.timeout(8000) });
      const ack = await socket
        .timeout(5000)
        .emitWithAck("session:watch", { sessionId: session.id });
      assert.equal(ack.ok, true, JSON.stringify(ack));
      return updates;
    }
    const updates = await watch(viewer);
    const guestUpdates = await watch(guest);
    async function untilUpdated(pollId, version) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const result = updates.find(
          (event) => event.pollId === pollId && event.version === version,
        );
        if (result) return result;
        await pause(30);
      }
      assert.fail(`Missing poll update ${pollId} version ${version}`);
    }
    await call(null, "GET", polls, undefined, 401);
    await call(viewer, "POST", polls, body, 403);
    await call(guest, "GET", polls, undefined, 403);
    for (const invalid of [
      { ...body, options: [{ text: "A" }] },
      { ...body, options: [{ text: " " }, { text: "B" }] },
      { ...body, options: [{ text: "A", count: 5 }, { text: "B" }] },
    ])
      await call(host, "POST", polls, invalid, 400);

    const { poll } = await call(host, "POST", polls, body, 201);
    assert.equal(poll.question, body.question.trim());
    assert.equal(poll.myOptionId, null);
    const publicEvent = await untilUpdated(poll.id, "1");
    assert.deepEqual(Object.keys(publicEvent).sort(), [
      "options",
      "pollId",
      "question",
      "sessionId",
      "status",
      "totalVotes",
      "version",
    ]);
    assert.equal(publicEvent.sessionId, session.id);
    assert.deepEqual(publicEvent.options, poll.options);

    const { poll: second } = await call(owner, "POST", polls, body, 201);
    const vote = `/polls/${poll.id}/vote`;
    const close = `/polls/${poll.id}/close`;
    const [a, b] = poll.options.map(({ id }) => id);
    await call(viewer, "POST", close, {}, 403);
    await call(guest, "PUT", vote, { optionId: a }, 403);
    await call(
      viewer,
      "PUT",
      vote,
      { optionId: second.options[0].id },
      400,
      "OPTION_NOT_IN_POLL",
    );

    await Promise.all([
      call(viewer, "PUT", vote, { optionId: a }),
      call(other, "PUT", vote, { optionId: b }),
    ]);
    const tally = await untilUpdated(poll.id, "3");
    assert.equal(tally.totalVotes, 2);
    assert.deepEqual(
      tally.options.map(({ count }) => count),
      [1, 1],
    );
    const { poll: changed } = await call(viewer, "PUT", vote, { optionId: b });
    assert.equal(changed.myOptionId, b);
    assert.equal(changed.totalVotes, 2);
    assert.deepEqual(
      changed.options.map(({ count }) => count),
      [0, 2],
    );
    const repeat = await call(viewer, "PUT", vote, { optionId: b });
    assert.equal(repeat.poll.version, changed.version);

    const page = await call(viewer, "GET", `${polls}?limit=1`);
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const remaining = await call(
      viewer,
      "GET",
      `${polls}?limit=1&cursor=${page.nextCursor}`,
    );
    const all = [...page.items, ...remaining.items];
    assert.equal(all.find(({ id }) => id === poll.id).myOptionId, b);
    assert.equal(
      (await call(host, "GET", polls)).items.find(({ id }) => id === poll.id)
        .myOptionId,
      null,
    );
    assert.deepEqual(guestUpdates, []);

    const [race, { poll: closed }] = await Promise.all([
      f.api(viewer, "PUT", vote, { optionId: a }),
      call(host, "POST", close, {}),
    ]);
    assert.ok([200, 409].includes(race.status));
    if (race.status === 409) assert.equal(race.body.error.code, "POLL_CLOSED");
    assert.equal(closed.status, "CLOSED");
    assert.deepEqual(
      closed.options.map(({ count }) => count),
      race.status === 200 ? [1, 1] : [0, 2],
    );
    assert.equal(
      (await untilUpdated(poll.id, closed.version)).status,
      "CLOSED",
    );
    assert.equal(
      (await call(host, "POST", close, {})).poll.version,
      closed.version,
    );
    await call(viewer, "PUT", vote, { optionId: b }, 409, "POLL_CLOSED");
    await call(host, "PUT", `${room}/bans/${other.id}`, {});
    await call(other, "GET", polls, undefined, 403, "BANNED");
    await call(host, "POST", `${room}/end`, {});
    assert.equal((await untilUpdated(second.id, "2")).status, "CLOSED");
    assert.equal(
      (await call(viewer, "GET", polls)).items.find(
        ({ id }) => id === second.id,
      ).status,
      "CLOSED",
    );
  },
);
