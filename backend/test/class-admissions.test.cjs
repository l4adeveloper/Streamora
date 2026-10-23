const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createValidationPipe } = require("../dist/common/validation");
const {
  DecideClassJoinDto,
  ClassJoinRequestListQueryDto,
} = require("../dist/modules/class-sessions/class-admissions.dto");
const {
  exportClassSessionsOpenApi,
} = require("../scripts/export-class-sessions-openapi.cjs");
const pipe = createValidationPipe();

test("T04 admission DTOs reject forged decisions, identities, roles and unsupported query fields", async () => {
  for (const decision of [
    null,
    undefined,
    "ACCEPTED",
    "accept",
    ["ACCEPT"],
    true,
  ])
    await assert.rejects(
      pipe.transform(
        { decision },
        { type: "body", metatype: DecideClassJoinDto },
      ),
    );
  for (const extra of [
    { userId: "other" },
    { status: "ACCEPTED" },
    { role: "HOST" },
    { decidedById: "other" },
  ])
    await assert.rejects(
      pipe.transform(
        { decision: "ACCEPT", ...extra },
        { type: "body", metatype: DecideClassJoinDto },
      ),
    );
  for (const query of [
    { status: "pending" },
    { status: null },
    { status: ["PENDING"] },
    { userId: "other" },
    { limit: "101" },
  ])
    await assert.rejects(
      pipe.transform(query, {
        type: "query",
        metatype: ClassJoinRequestListQueryDto,
      }),
    );
  assert.equal(
    (
      await pipe.transform(
        {},
        { type: "query", metatype: ClassJoinRequestListQueryDto },
      )
    ).status,
    "PENDING",
  );
});

test("T04 admission OpenAPI requires replay keys and exposes only safe admission contracts", async () => {
  const doc = await exportClassSessionsOpenApi({ check: true });
  const root = "/api/v1/sessions/{sessionId}";
  assert.equal(Object.values(doc.paths).flatMap(Object.values).length, 19);
  for (const path of ["join-requests", "enter"]) {
    const operation = doc.paths[`${root}/${path}`].post;
    assert.ok(
      operation.parameters.some(
        (p) => p.in === "header" && p.name === "Idempotency-Key" && p.required,
      ),
    );
    assert.equal(
      operation.requestBody.content["application/json"].schema
        .additionalProperties,
      false,
    );
  }
  assert.deepEqual(
    doc.components.schemas.DecideClassJoinDto.properties.decision.enum,
    ["ACCEPT", "REJECT"],
  );
  assert.equal(
    doc.components.schemas.DecideClassJoinDto.additionalProperties,
    false,
  );
  const fields = JSON.stringify([
    doc.components.schemas.ClassJoinRequestDto,
    doc.components.schemas.ClassParticipationDto,
    doc.components.schemas.ClassSessionUserDto,
  ]);
  assert.doesNotMatch(fields, /password|token|email|livekit/i);
});
