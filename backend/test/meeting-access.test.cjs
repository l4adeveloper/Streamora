const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { createMeetingFixture } = require("./meeting-fixture.cjs");
const { io } = require("socket.io-client");

test(
  "Meeting access is resolved by membership; guests need permission and approval; creation is durable and idempotent",
  { timeout: 120000 },
  async () => {
    const f = await createMeetingFixture();
    try {
      const owner = await f.account("Chủ lớp"),
        member = await f.account("Học viên"),
        guest = await f.account("Khách");
      const group = await f.prisma.group.create({
        data: {
          name: "Lớp A",
          ownerId: owner.id,
          members: {
            create: [
              { userId: owner.id, role: "OWNER" },
              { userId: member.id, role: "VIEWER" },
            ],
          },
        },
      });
      const admin = await f.account("Quản trị viên", "ADMIN");
      const create = async (body, key = randomUUID()) => {
        const result = await f.api(
          owner,
          "POST",
          `/groups/${group.id}/sessions`,
          body,
          key,
        );
        assert.equal(result.status, 201, JSON.stringify(result.body));
        return result.body.session;
      };
      const key = randomUUID();
      const closed = await create({}, key);
      assert.equal(closed.title, "Cuộc họp 1");
      assert.equal((await create({}, key)).id, closed.id);
      assert.equal(
        (await f.api(admin, "GET", `/meets/${closed.joinCode}`)).body.meet.mode,
        "WORKSPACE",
      );
      assert.equal(
        await f.prisma.groupChatMessage.count({
          where: { meetingId: closed.id },
        }),
        1,
      );
      const announcement = await f.prisma.groupChatMessage.findUnique({
        where: { meetingId: closed.id },
      });
      assert.equal(announcement.channel, "thông-báo");
      assert.ok(announcement.text.includes(`/meet/${closed.joinCode}`));
      const socket = io(`${f.base.replace(/\/api\/v1$/, "")}/classroom`, {
        auth: { accessToken: member.token },
        transports: ["websocket"],
        extraHeaders: { Origin: f.config.webOrigin },
      });
      try {
        await new Promise((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("connect_error", reject);
        });
        const history = await socket.timeout(5000).emitWithAck("channel:join", {
          groupId: group.id,
          channel: "thông-báo",
        });
        assert.equal(history.ok, true);
        assert.ok(
          history.messages.some((message) => message.meetingId === closed.id),
        );
        const delivery = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Meeting announcement was not delivered")),
            5000,
          );
          socket.on("meeting.created", (payload) => {
            clearTimeout(timer);
            resolve(payload);
          });
        });
        const announced = await create({ title: "Kiểm tra thông báo" });
        assert.equal((await delivery).groupId, group.id);
        const update = () =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              socket.off("meeting.updated", receive);
              reject(new Error("Room state was not synchronized"));
            }, 5000);
            const receive = (payload) => {
              if (payload.sessionId === announced.id) {
                clearTimeout(timer);
                socket.off("meeting.updated", receive);
                resolve(payload);
              }
            };
            socket.on("meeting.updated", receive);
          });
        let updated = update();
        assert.equal(
          (
            await f.api(
              owner,
              "POST",
              `/sessions/${announced.id}/start`,
              {},
              randomUUID(),
            )
          ).status,
          200,
        );
        await updated;
        updated = update();
        assert.equal(
          (
            await f.api(owner, "PATCH", `/sessions/${announced.id}`, {
              title: "Tên đã đổi",
            })
          ).status,
          200,
        );
        await updated;
        updated = update();
        assert.equal(
          (
            await f.api(
              owner,
              "POST",
              `/sessions/${announced.id}/end`,
              {},
              randomUUID(),
            )
          ).status,
          200,
        );
        await updated;
        assert.equal(
          await f.prisma.groupChatMessage.count({
            where: { meetingId: announced.id },
          }),
          1,
        );
      } finally {
        socket.disconnect();
      }
      const publicMeeting = await create({ allowGuests: true });
      assert.equal(publicMeeting.title, "Cuộc họp 3");
      const named = await create({ title: "Ôn tập" });
      assert.equal(named.title, "Ôn tập");
      assert.equal((await create({})).title, "Cuộc họp 5");
      const legacy = await create({
        title: "Lớp dùng hàng chờ",
        memberAdmission: "APPROVAL",
      });
      await f.api(
        owner,
        "POST",
        `/sessions/${legacy.id}/start`,
        {},
        randomUUID(),
      );
      const legacyAdmission = (
        await f.api(member, "GET", `/sessions/${legacy.id}/admission`)
      ).body;
      assert.equal(legacyAdmission.permissions.canEnter, false);
      assert.equal(legacyAdmission.permissions.canRequestJoin, true);
      assert.equal(
        (
          await f.api(
            member,
            "POST",
            `/groups/${group.id}/sessions`,
            {},
            randomUUID(),
          )
        ).status,
        403,
      );
      assert.equal(
        (await f.api(null, "GET", `/meets/${closed.joinCode}`)).status,
        401,
      );
      for (const path of [
        `/meets/${closed.joinCode}`,
        `/sessions/${closed.id}/access`,
        `/sessions/${closed.id}`,
        `/sessions/${closed.id}/admission`,
      ])
        assert.equal((await f.api(guest, "GET", path)).status, 403, path);
      assert.equal(
        (await f.api(member, "GET", `/meets/${closed.joinCode}`)).body.meet
          .mode,
        "WORKSPACE",
      );
      assert.equal(
        (await f.api(member, "GET", `/meets/${publicMeeting.joinCode}`)).body
          .meet.mode,
        "WORKSPACE",
      );
      assert.equal(
        (await f.api(guest, "GET", `/meets/${publicMeeting.joinCode}`)).body
          .meet.mode,
        "STANDALONE",
      );
      await f.api(
        owner,
        "POST",
        `/sessions/${publicMeeting.id}/start`,
        {},
        randomUUID(),
      );
      assert.equal(
        (
          await f.api(
            guest,
            "POST",
            `/sessions/${publicMeeting.id}/enter`,
            {},
            randomUUID(),
          )
        ).status,
        403,
      );
      assert.equal(
        (await f.api(member, "GET", `/sessions/${publicMeeting.id}/admission`))
          .body.permissions.canEnter,
        true,
      );
      assert.equal(
        (
          await f.api(
            member,
            "POST",
            `/sessions/${publicMeeting.id}/enter`,
            {},
            randomUUID(),
          )
        ).status,
        200,
      );
      const requested = await f.api(
        guest,
        "POST",
        `/sessions/${publicMeeting.id}/join-requests`,
        {},
        randomUUID(),
      );
      assert.equal(requested.status, 200, JSON.stringify(requested.body));
      assert.equal(
        (
          await f.api(
            guest,
            "GET",
            `/sessions/${publicMeeting.id}/participants`,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await f.api(guest, "PATCH", `/sessions/${publicMeeting.id}`, {
            title: "Forged",
          })
        ).status,
        403,
      );
      const requestId = requested.body.request.id;
      assert.equal(
        (
          await f.api(
            owner,
            "PATCH",
            `/sessions/${publicMeeting.id}/join-requests/${requestId}`,
            { decision: "ACCEPT" },
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await f.api(
            guest,
            "POST",
            `/sessions/${publicMeeting.id}/enter`,
            {},
            randomUUID(),
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await f.api(owner, "PATCH", `/sessions/${publicMeeting.id}`, {
            title: "Tên mới",
          })
        ).status,
        200,
      );
      assert.equal(
        (await f.api(guest, "GET", `/meets/${publicMeeting.joinCode}`)).body
          .meet.title,
        "Tên mới",
      );
      const independent = (
        await f.api(owner, "POST", "/meets", { title: "Độc lập" }, randomUUID())
      ).body.session;
      assert.equal(
        (await f.api(member, "GET", `/meets/${independent.joinCode}`)).body.meet
          .mode,
        "STANDALONE",
      );
      await f.prisma.sessionBan.create({
        data: { sessionId: publicMeeting.id, userId: guest.id },
      });
      assert.equal(
        (await f.api(guest, "GET", `/meets/${publicMeeting.joinCode}`)).status,
        403,
      );
      await f.prisma.group.update({
        where: { id: group.id },
        data: { deletedAt: new Date() },
      });
      assert.equal(
        (await f.api(guest, "GET", `/meets/${publicMeeting.joinCode}`)).status,
        403,
      );
      assert.equal(
        (await f.api(member, "GET", `/meets/${closed.joinCode}`)).status,
        404,
      );
    } finally {
      await f.cleanup();
    }
  },
);
