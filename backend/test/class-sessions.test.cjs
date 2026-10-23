const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createValidationPipe } = require("../dist/common/validation");
const {
  CreateGroupClassSessionDto,
  CreateMeetDto,
  UpdateClassSessionDto,
  ClassSessionListQueryDto,
  EmptySessionActionPipe,
} = require("../dist/modules/class-sessions/class-sessions.dto");
const {
  exportClassSessionsOpenApi,
} = require("../scripts/export-class-sessions-openapi.cjs");
const pipe = createValidationPipe();
const validate = (type, value, location = "body") =>
  pipe.transform(value, { type: location, metatype: type });

test("T04 validates real zoned timestamps, rejects forged ownership/state, and distinguishes null from omission", async () => {
  const valid = {
    title: " Lớp học ",
    scheduledAt: "2026-10-25T19:00:00+07:00",
  };
  assert.equal(
    (await validate(CreateGroupClassSessionDto, valid)).title,
    "Lớp học",
  );
  for (const value of [
    undefined,
    null,
    "2026-10-25",
    "2026-10-25T19:00:00",
    "2026-02-30T19:00:00Z",
    [valid.scheduledAt],
  ])
    await assert.rejects(
      validate(CreateGroupClassSessionDto, { ...valid, scheduledAt: value }),
    );
  for (const extra of [
    { createdById: "other" },
    { groupId: "other" },
    { kind: "MEET" },
    { status: "LIVE" },
    { joinCode: "ABCDEF123456" },
  ])
    await assert.rejects(
      validate(CreateGroupClassSessionDto, { ...valid, ...extra }),
    );
  for (const title of [null, "  ", [], "x".repeat(101)])
    await assert.rejects(validate(CreateMeetDto, { title }));
  await assert.rejects(
    validate(CreateMeetDto, { title: "Meet", description: null }),
  );
  await assert.rejects(
    validate(CreateMeetDto, { title: "Meet", scheduledAt: null }),
  );
  assert.equal(
    (await validate(CreateMeetDto, { title: "Meet" })).scheduledAt,
    undefined,
  );
  await assert.rejects(validate(UpdateClassSessionDto, { title: null }));
  const update = await validate(UpdateClassSessionDto, {
    description: null,
    scheduledAt: null,
  });
  assert.equal(update.description, null);
  assert.equal(update.scheduledAt, null);
  for (const query of [
    { status: "live" },
    { status: ["LIVE"] },
    { status: null },
    { limit: "0" },
    { limit: "101" },
    { limit: "1e2" },
    { groupId: "other" },
  ])
    await assert.rejects(validate(ClassSessionListQueryDto, query, "query"));
});

test("T04 lifecycle commands accept only an absent body or an empty object", () => {
  const guard = new EmptySessionActionPipe();
  for (const value of [null, [], "", { status: "LIVE" }, { userId: "other" }])
    assert.throws(() => guard.transform(value));
  assert.equal(guard.transform(undefined), undefined);
  assert.deepEqual(guard.transform({}), {});
});

test("T04 OpenAPI publishes lifecycle and meet routes with authentication and minimal discovery", async () => {
  const doc = await exportClassSessionsOpenApi({ check: true });
  const operations = Object.values(doc.paths).flatMap(Object.values);
  assert.equal(operations.length, 19);
  for (const operation of operations)
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
  for (const name of [
    "CreateGroupClassSessionDto",
    "CreateMeetDto",
    "UpdateClassSessionDto",
  ])
    assert.equal(doc.components.schemas[name].additionalProperties, false);
  assert.ok(
    doc.components.schemas.CreateGroupClassSessionDto.required.includes(
      "scheduledAt",
    ),
  );
  assert.ok(
    !doc.components.schemas.CreateMeetDto.required.includes("scheduledAt"),
  );
  assert.deepEqual(
    Object.keys(doc.components.schemas.MeetPreviewDto.properties).sort(),
    ["host", "id", "status", "title"],
  );
  assert.deepEqual(
    Object.keys(doc.components.schemas.ClassSessionUserDto.properties).sort(),
    ["fullName", "id"],
  );
  const fields = JSON.stringify(
    doc.components.schemas.ClassSessionDto.properties,
  );
  assert.doesNotMatch(fields, /password|token|livekit/i);
  assert.equal(
    doc.paths["/api/v1/sessions/{sessionId}/start"].post.requestBody.content[
      "application/json"
    ].schema.additionalProperties,
    false,
  );
});
