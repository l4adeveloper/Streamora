const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { createMeetingFixture } = require("./meeting-fixture.cjs");
const { IvsService } = require("../dist/modules/class-media/ivs.service");

async function fixture(t, failure) {
  const f = await createMeetingFixture("http://127.0.0.1:3000", {
    ivs: {
      enabled: true,
      region: "ap-northeast-1",
      tokenTtlSeconds: 60,
      workerEnabled: false,
      eventsQueueUrl: "",
    },
  });
  t.after(() => f.cleanup());
  const stages = new Map();
  let creates = 0;
  f.app.get(IvsService).client.send = async (command) => {
    const name = command.constructor.name;
    if (name === "ListStagesCommand") return { stages: [...stages.values()] };
    if (name === "GetStageCommand")
      return { stage: stages.get(command.input.arn) };
    if (name === "CreateStageCommand") {
      creates++;
      const stage = {
        arn: `arn:aws:ivs:ap-northeast-1:123456789012:stage/${randomUUID()}`,
        ...command.input,
      };
      if (creates === 1 && failure === "denied") {
        const error = new Error(
          "AWS rejected the request before Stage creation",
        );
        error.name = "AccessDeniedException";
        error.$metadata = { httpStatusCode: 403 };
        throw error;
      }
      stages.set(stage.arn, stage);
      if (creates === 1 && failure === "uncertain") {
        const error = new Error(
          "Response lost after AWS accepted the operation",
        );
        error.name = "TimeoutError";
        throw error;
      }
      return { stage };
    }
    if (name === "CreateParticipantTokenCommand")
      return {
        participantToken: {
          token: randomUUID(),
          participantId: randomUUID(),
          expirationTime: new Date(Date.now() + 60000),
        },
      };
    if (name === "ListCompositionsCommand") return { compositions: [] };
    if (name === "DeleteStageCommand") stages.delete(command.input.arn);
    return {};
  };
  const owner = await f.account("Chủ phòng kiểm thử phục hồi");
  const group = await f.prisma.group.create({
    data: {
      name: "Lớp kiểm thử",
      ownerId: owner.id,
      members: { create: { userId: owner.id, role: "OWNER" } },
    },
  });
  const created = await f.api(
    owner,
    "POST",
    `/groups/${group.id}/sessions`,
    {},
    randomUUID(),
  );
  assert.equal(created.status, 201);
  const session = created.body.session;
  assert.equal(
    (
      await f.api(
        owner,
        "POST",
        `/sessions/${session.id}/start`,
        {},
        randomUUID(),
      )
    ).status,
    200,
  );
  const entry = await f.api(
    owner,
    "POST",
    `/sessions/${session.id}/enter`,
    {},
    randomUUID(),
  );
  assert.equal(entry.status, 200);
  const body = {
    participationId: entry.body.participation.id,
    clientId: randomUUID(),
    requestId: randomUUID(),
  };
  return {
    ...f,
    session,
    join: () => f.api(owner, "POST", `/sessions/${session.id}/join`, body),
    get creates() {
      return creates;
    },
  };
}

test("a definite AWS rejection does not lock room retries for two minutes", async (t) => {
  const f = await fixture(t, "denied");
  const failed = await f.join();
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  const retried = await f.join();
  assert.equal(
    retried.status,
    200,
    "Retry must succeed immediately after the AWS rejection is fixed",
  );
  assert.equal(f.creates, 2);
});

test("an uncertain Stage result retains its lease and recovers the tagged Stage without creating a duplicate", async (t) => {
  const f = await fixture(t, "uncertain");
  const failed = await f.join();
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  const waiting = await f.join();
  assert.equal(waiting.status, 409);
  assert.equal(waiting.body.error.code, "MEDIA_STARTING");
  await f.prisma.classMediaRoom.update({
    where: { sessionId: f.session.id },
    data: { leaseUntil: new Date(Date.now() - 1000) },
  });
  assert.equal((await f.join()).status, 200);
  assert.equal(f.creates, 1, "The tagged Stage must be recovered");
});
