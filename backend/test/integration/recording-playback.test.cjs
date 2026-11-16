const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMeetingFixture } = require("../meeting-fixture.cjs");

test(
  "recording APIs enforce membership, publication, progress ownership and stale writes",
  { timeout: 120000 },
  async () => {
    const f = await createMeetingFixture();
    try {
      const owner = await f.account("Playback owner"),
        viewer = await f.account("Playback viewer"),
        outsider = await f.account("Outsider");
      const db = f.prisma;
      const group = await db.group.create({
        data: { name: "Playback", ownerId: owner.id },
      });
      await db.groupMember.create({
        data: { groupId: group.id, userId: viewer.id, role: "VIEWER" },
      });
      const session = await db.classSession.create({
        data: {
          kind: "GROUP",
          groupId: group.id,
          createdById: owner.id,
          title: "Recorded lesson",
          joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
          status: "ENDED",
          scheduledAt: new Date(),
          startedAt: new Date(),
          endedAt: new Date(),
        },
      });
      const file = await db.libraryFile.create({
        data: {
          groupId: group.id,
          sessionId: session.id,
          createdBy: owner.id,
          name: "Lesson.mp4",
          objectKey: `test/${randomUUID()}`,
          size: 100n,
          mimeType: "video/mp4",
          source: "DOCUMENT",
          status: "AVAILABLE",
        },
      });
      const recording = await db.classRecording.create({
        data: {
          id: randomUUID(),
          sessionId: session.id,
          recorderId: owner.id,
          status: "SAVED",
          fileId: file.id,
        },
      });
      const path = `/recordings/${recording.id}`;
      assert.equal((await f.api(outsider, "GET", path)).status, 403);
      assert.equal((await f.api(viewer, "GET", path)).status, 200);
      assert.equal(
        (await f.api(viewer, "GET", path + "/progress")).body.positionSeconds,
        0,
      );
      const now = Date.now() - 1000;
      const save = (actor, position, time) =>
        f.api(actor, "PUT", path + "/progress", {
          positionSeconds: position,
          clientUpdatedAt: new Date(time).toISOString(),
        });
      assert.equal((await save(viewer, 25, now)).body.positionSeconds, 25);
      assert.equal(
        (await save(viewer, 10, now - 1000)).body.positionSeconds,
        25,
      );
      assert.equal(
        (await f.api(owner, "GET", path + "/progress")).body.positionSeconds,
        0,
      );
      assert.equal((await save(viewer, 0, now + 100)).body.positionSeconds, 0);
      assert.equal((await save(viewer, -1, now + 200)).status, 400);
      assert.equal((await save(viewer, 1, Date.now() + 120000)).status, 400);
      await db.libraryFile.update({
        where: { id: file.id },
        data: { isPublished: false },
      });
      assert.equal((await f.api(viewer, "GET", path)).status, 403);
      assert.equal(
        (await f.api(viewer, "GET", `/groups/${group.id}/recordings`)).body
          .items.length,
        0,
      );
      assert.equal(
        (await f.api(owner, "GET", `/groups/${group.id}/recordings`)).body.items
          .length,
        1,
      );
      await db.groupMember.delete({
        where: { userId_groupId: { userId: viewer.id, groupId: group.id } },
      });
      assert.equal((await save(viewer, 40, Date.now())).status, 403);
    } finally {
      await f.cleanup();
    }
  },
);
