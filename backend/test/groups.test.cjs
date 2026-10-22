const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const { randomUUID } = require("node:crypto");
const { createValidationPipe } = require("../dist/common/validation");
const {
  CreateGroupDto,
  UpdateGroupDto,
  GroupListQueryDto,
} = require("../dist/modules/groups/groups.dto");
const { GroupsService } = require("../dist/modules/groups/groups.service");
const { ApiError } = require("../dist/common/api-error");

describe("T02: Groups DTO Validation", () => {
  const pipe = createValidationPipe();

  test("CreateGroupDto validates required name and length constraints", async () => {
    // Valid input
    const valid = await pipe.transform(
      { name: "Điện toán đám mây K69", description: "Mô tả nhóm học tập" },
      { type: "body", metatype: CreateGroupDto },
    );
    assert.equal(valid.name, "Điện toán đám mây K69");
    assert.equal(valid.description, "Mô tả nhóm học tập");

    // Empty name should fail
    await assert.rejects(
      pipe.transform({ name: "" }, { type: "body", metatype: CreateGroupDto }),
      (err) => {
        const body = err.getResponse();
        assert.equal(body.error.code, "VALIDATION_ERROR");
        return true;
      },
    );

    // Name exceeding 100 characters should fail
    await assert.rejects(
      pipe.transform(
        { name: "a".repeat(101) },
        { type: "body", metatype: CreateGroupDto },
      ),
      (err) => {
        const body = err.getResponse();
        assert.equal(body.error.code, "VALIDATION_ERROR");
        return true;
      },
    );

    // Description exceeding 500 characters should fail
    await assert.rejects(
      pipe.transform(
        { name: "Valid Name", description: "d".repeat(501) },
        { type: "body", metatype: CreateGroupDto },
      ),
      (err) => {
        const body = err.getResponse();
        assert.equal(body.error.code, "VALIDATION_ERROR");
        return true;
      },
    );
  });

  test("UpdateGroupDto allows partial updates with valid constraints", async () => {
    const valid = await pipe.transform(
      { name: "Tên mới" },
      { type: "body", metatype: UpdateGroupDto },
    );
    assert.equal(valid.name, "Tên mới");
    assert.equal(valid.description, undefined);

    // Name too long fails
    await assert.rejects(
      pipe.transform(
        { name: "x".repeat(101) },
        { type: "body", metatype: UpdateGroupDto },
      ),
      (err) => {
        assert.equal(err.getResponse().error.code, "VALIDATION_ERROR");
        return true;
      },
    );
  });

  test("GroupListQueryDto validates search and pagination parameters", async () => {
    const valid = await pipe.transform(
      { q: "toán", limit: 10 },
      { type: "query", metatype: GroupListQueryDto },
    );
    assert.equal(valid.q, "toán");
    assert.equal(valid.limit, 10);
  });

  test("partial updates reject null names and allow clearing descriptions", async () => {
    await assert.rejects(
      pipe.transform(
        { name: null },
        { type: "body", metatype: UpdateGroupDto },
      ),
      (err) => err.getStatus() === 400,
    );
    const result = await pipe.transform(
      { description: null },
      { type: "body", metatype: UpdateGroupDto },
    );
    assert.equal(result.description, null);
  });
});

describe("T02: GroupsService Business Logic & Isolation", () => {
  function createMockPrisma() {
    const groups = new Map();
    const members = new Map();
    const requests = new Map();

    return {
      groups,
      members,
      group: {
        create: async ({ data, select }) => {
          const id = randomUUID();
          const record = {
            id,
            name: data.name,
            description: data.description ?? null,
            ownerId: data.ownerId,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          };
          groups.set(id, record);
          return record;
        },
        findFirst: async ({ where }) => {
          for (const g of groups.values()) {
            if (where.id && g.id !== where.id) continue;
            if (where.deletedAt === null && g.deletedAt !== null) continue;
            if (where.members?.some?.userId) {
              const uId = where.members.some.userId;
              const hasMember = Array.from(members.values()).some(
                (m) => m.groupId === g.id && m.userId === uId,
              );
              if (!hasMember) continue;
            }
            return g;
          }
          return null;
        },
        findMany: async ({ where, take, orderBy }) => {
          let results = [];
          for (const g of groups.values()) {
            if (where.deletedAt === null && g.deletedAt !== null) continue;
            if (
              where.OR &&
              !where.OR.some(
                (condition) =>
                  condition.ownerId === g.ownerId ||
                  members.has(`${condition.members?.some?.userId}_${g.id}`),
              )
            )
              continue;
            if (where.members?.some?.userId) {
              const uId = where.members.some.userId;
              const hasMember = Array.from(members.values()).some(
                (m) => m.groupId === g.id && m.userId === uId,
              );
              if (!hasMember) continue;
            }
            if (where.name?.contains) {
              if (
                !g.name
                  .toLowerCase()
                  .includes(where.name.contains.toLowerCase())
              )
                continue;
            }
            results.push(g);
          }
          // Sort desc by createdAt
          results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          if (take) results = results.slice(0, take);
          return results;
        },
        update: async ({ where, data }) => {
          const g = groups.get(where.id);
          if (!g || (where.deletedAt === null && g.deletedAt !== null)) {
            throw new Error("Record not found");
          }
          if (data.name !== undefined) g.name = data.name;
          if (data.description !== undefined) g.description = data.description;
          if (data.deletedAt !== undefined) g.deletedAt = data.deletedAt;
          g.updatedAt = new Date();
          return g;
        },
      },
      groupMember: {
        create: async ({ data }) => {
          const key = `${data.userId}_${data.groupId}`;
          const record = {
            userId: data.userId,
            groupId: data.groupId,
            role: data.role,
            joinedAt: new Date(),
          };
          members.set(key, record);
          return record;
        },
        findUnique: async ({ where }) => {
          const key = `${where.userId_groupId.userId}_${where.userId_groupId.groupId}`;
          return members.get(key) || null;
        },
      },
      groupCreateRequest: {
        findUnique: async ({ where: { userId_key } }) =>
          requests.get(`${userId_key.userId}:${userId_key.key}`) ?? null,
        create: async ({ data }) =>
          requests.set(`${data.userId}:${data.key}`, data),
      },
      $queryRaw: async () => [],
      async $transaction(fn) {
        return fn(this);
      },
    };
  }

  test("T02-01: Create group in transaction and assign OWNER role to creator", async () => {
    const mockPrisma = createMockPrisma();
    const service = new GroupsService(mockPrisma);
    const userId = randomUUID();

    const res = await service.create(userId, {
      name: "Kiến trúc máy tính",
      description: "Thảo luận bài tập",
    });

    assert.ok(res.group.id);
    assert.equal(res.group.name, "Kiến trúc máy tính");
    assert.equal(res.group.ownerId, userId);

    // Verify creator is OWNER in members table
    const membership = await mockPrisma.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId: res.group.id } },
    });
    assert.ok(membership);
    assert.equal(membership.role, "OWNER");
  });

  test("T02-01: Idempotency-Key returns cached response on repeated request", async () => {
    const mockPrisma = createMockPrisma();
    const service = new GroupsService(mockPrisma);
    const userId = randomUUID();
    const idempotencyKey = "key-abc-123";

    const res1 = await service.create(
      userId,
      { name: "Mạng máy tính" },
      idempotencyKey,
    );
    const res2 = await service.create(
      userId,
      { name: "Mạng máy tính" },
      idempotencyKey,
    );

    assert.equal(res1.group.id, res2.group.id);
    assert.equal(mockPrisma.groups.size, 1);
  });

  test("T02-02: List groups isolates groups between users (Data Isolation)", async () => {
    const mockPrisma = createMockPrisma();
    const service = new GroupsService(mockPrisma);

    const userAlice = randomUUID();
    const userBob = randomUUID();

    // Alice creates Group A
    const groupA = await service.create(userAlice, {
      name: "Group A của Alice",
    });
    // Bob creates Group B
    const groupB = await service.create(userBob, { name: "Group B của Bob" });

    // Alice lists groups — only sees Group A
    const aliceList = await service.list(userAlice, {});
    assert.equal(aliceList.items.length, 1);
    assert.equal(aliceList.items[0].id, groupA.group.id);

    // Bob lists groups — only sees Group B
    const bobList = await service.list(userBob, {});
    assert.equal(bobList.items.length, 1);
    assert.equal(bobList.items[0].id, groupB.group.id);

    // Admin sees both groups
    const adminList = await service.list(randomUUID(), {}, true);
    assert.equal(adminList.items.length, 2);
  });

  test("T02-03: findOne allows members and rejects non-members with 403", async () => {
    const mockPrisma = createMockPrisma();
    const service = new GroupsService(mockPrisma);

    const userAlice = randomUUID();
    const userBob = randomUUID();

    const created = await service.create(userAlice, { name: "Nhóm kín" });

    // Alice is member/owner — can view
    const viewAlice = await service.findOne(userAlice, created.group.id);
    assert.equal(viewAlice.group.name, "Nhóm kín");

    // Bob is not a member — rejected with 403 FORBIDDEN
    await assert.rejects(service.findOne(userBob, created.group.id), (err) => {
      assert.equal(err.getStatus(), 403);
      assert.equal(err.getResponse().error.code, "FORBIDDEN");
      return true;
    });

    // Admin can view even without direct membership
    const adminView = await service.findOne(userBob, created.group.id, true);
    assert.equal(adminView.group.id, created.group.id);
  });

  test("T02-04: update allows OWNER and rejects non-owner with 403", async () => {
    const mockPrisma = createMockPrisma();
    const service = new GroupsService(mockPrisma);

    const userAlice = randomUUID();
    const userBob = randomUUID();

    const created = await service.create(userAlice, { name: "Tên cũ" });

    // Non-owner cannot update
    await assert.rejects(
      service.update(userBob, created.group.id, { name: "Hack tên" }),
      (err) => {
        assert.equal(err.getStatus(), 403);
        assert.equal(err.getResponse().error.code, "FORBIDDEN");
        return true;
      },
    );

    // Owner can update
    const updated = await service.update(userAlice, created.group.id, {
      name: "Tên mới",
    });
    assert.equal(updated.group.name, "Tên mới");
  });

  test("T02-05: remove performs soft-delete and excludes group from active list", async () => {
    const mockPrisma = createMockPrisma();
    const service = new GroupsService(mockPrisma);

    const userAlice = randomUUID();
    const created = await service.create(userAlice, { name: "Nhóm sắp xóa" });

    // Soft delete
    await service.remove(userAlice, created.group.id);

    // In active list: not found
    const list = await service.list(userAlice, {});
    assert.equal(list.items.length, 0);

    // In findOne: throws 404 GROUP_NOT_FOUND
    await assert.rejects(
      service.findOne(userAlice, created.group.id),
      (err) => {
        assert.equal(err.getStatus(), 404);
        assert.equal(err.getResponse().error.code, "GROUP_NOT_FOUND");
        return true;
      },
    );
  });

  test("T02 rejects malformed cursors before querying the database", async () => {
    const service = new GroupsService(createMockPrisma());
    for (const value of [
      "?",
      {},
      null,
      { createdAt: "invalid", id: randomUUID() },
      { createdAt: new Date().toISOString(), id: "not-a-uuid" },
    ]) {
      const cursor =
        typeof value === "string"
          ? value
          : Buffer.from(JSON.stringify(value)).toString("base64url");
      await assert.rejects(
        service.list(randomUUID(), { cursor }),
        (err) => err.getResponse().error.code === "INVALID_CURSOR",
      );
    }
  });
});
