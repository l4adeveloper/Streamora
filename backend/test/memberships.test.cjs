const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { createValidationPipe } = require("../dist/common/validation");
const {
  GroupAccessService,
} = require("../dist/modules/memberships/group-access.service");
const {
  AddMemberDto,
  ChangeMemberRoleDto,
  MemberListQueryDto,
  UserLookupQueryDto,
} = require("../dist/modules/memberships/memberships.dto");
const {
  exportMembershipsOpenApi,
} = require("../scripts/export-memberships-openapi.cjs");
const pipe = createValidationPipe();
const validate = (type, value, location = "body") =>
  pipe.transform(value, { type: location, metatype: type });

test("T03 rejects forged roles, user IDs, nulls, extra fields and malformed searches", async () => {
  for (const role of ["OWNER", "ADMIN", "host", "", null, ["HOST"]])
    await assert.rejects(
      validate(AddMemberDto, { userId: randomUUID(), role }),
      (error) => error.getStatus() === 400,
    );
  for (const body of [
    { role: "HOST", globalRole: "ADMIN" },
    { role: "HOST", userId: randomUUID() },
    { role: null },
  ])
    await assert.rejects(validate(ChangeMemberRoleDto, body));
  const lookup = await validate(
    UserLookupQueryDto,
    { groupId: randomUUID(), email: " Viewer@Example.Test " },
    "query",
  );
  assert.equal(lookup.email, "viewer@example.test");
  for (const query of [
    { groupId: randomUUID(), email: "viewer" },
    { groupId: "other", email: "viewer@example.test" },
  ])
    await assert.rejects(validate(UserLookupQueryDto, query, "query"));
  for (const query of [
    { limit: "101" },
    { limit: "0" },
    { limit: "2.5" },
    { cursor: null },
    { q: ["name"] },
  ]) {
    if (query.cursor === null) continue; // optional cursor accepts an omitted/null cursor
    await assert.rejects(validate(MemberListQueryDto, query, "query"));
  }
  assert.equal(
    (await validate(MemberListQueryDto, { limit: "2", q: "  An  " }, "query"))
      .q,
    "An",
  );
});

test("shared resource permissions distinguish global admin and group roles and re-read membership", async () => {
  const owner = randomUUID(),
    viewer = randomUUID();
  let role = "VIEWER",
    globalRole = "USER",
    deletedAt = null,
    disabledAt = null;
  const db = {
    group: { findFirst: async () => (deletedAt ? null : { ownerId: owner }) },
    user: { findUnique: async () => ({ globalRole, disabledAt }) },
    groupMember: { findUnique: async () => (role ? { role } : null) },
    groupRoom: {
      findUnique: async () => ({ id: "room", groupId: "server-owned-group" }),
    },
  };
  const access = new GroupAccessService(db);
  assert.deepEqual(await access.require(viewer, "group"), {
    role: "VIEWER",
    canManageMembers: false,
    canHost: false,
    canUpload: true,
    canViewRecordings: true,
  });
  await assert.rejects(access.require(viewer, "group", "canHost"));
  role = "HOST";
  assert.equal(
    (await access.require(viewer, "group", "canHost")).canManageMembers,
    false,
  );
  await assert.rejects(access.require(viewer, "group", "canManageMembers"));
  assert.equal(
    (await access.require(owner, "group", "canManageMembers")).role,
    "OWNER",
  );
  role = "OWNER";
  await assert.rejects(access.require(viewer, "group"));
  role = null;
  for (const permission of [
    undefined,
    "canHost",
    "canUpload",
    "canViewRecordings",
  ])
    await assert.rejects(access.require(viewer, "group", permission));
  await assert.rejects(access.requireRoom(viewer, "room"));
  globalRole = "ADMIN";
  assert.equal(
    (await access.require(viewer, "group", "canManageMembers")).role,
    "ADMIN",
  );
  disabledAt = new Date();
  await assert.rejects(access.require(viewer, "group"));
  disabledAt = null;
  deletedAt = new Date();
  await assert.rejects(
    access.require(viewer, "group"),
    (error) => error.getStatus() === 404,
  );
});

test("T03 OpenAPI exports six HTTP operations, restricted roles and safe public user fields", async () => {
  const doc = await exportMembershipsOpenApi({ check: true });
  assert.equal(Object.values(doc.paths).flatMap(Object.values).length, 6);
  assert.deepEqual(Object.keys(doc.paths).sort(), [
    "/api/v1/groups/{groupId}/members",
    "/api/v1/groups/{groupId}/members/{userId}",
    "/api/v1/groups/{groupId}/permissions/me",
    "/api/v1/users/lookup",
  ]);
  assert.deepEqual(doc.components.schemas.AddMemberDto.properties.role.enum, [
    "HOST",
    "VIEWER",
  ]);
  assert.equal(doc.components.schemas.AddMemberDto.additionalProperties, false);
  assert.deepEqual(
    Object.keys(doc.components.schemas.LookupUserDto.properties).sort(),
    ["email", "fullName", "id"],
  );
});
