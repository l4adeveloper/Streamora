const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ClassSessionAutoCloseService,
} = require("../dist/modules/class-sessions/class-session-auto-close.service");

function mockPrisma() {
  const sessions = new Map();
  const participations = new Map();
  const leases = new Map();

  return {
    sessions,
    participations,
    leases,
    classSession: {
      async findUnique({ where }) {
        return sessions.get(where.id) ?? null;
      },
      async findMany({ where }) {
        const results = [];
        for (const s of sessions.values()) {
          if (!where || !where.status || s.status === where.status) {
            results.push(s);
          }
        }
        return results;
      },
      async update({ where, data }) {
        const s = sessions.get(where.id);
        if (!s) throw new Error("Not found");
        Object.assign(s, data);
        return s;
      },
    },
    classParticipation: {
      async count({ where }) {
        let count = 0;
        const gt = where?.AND?.[0]?.OR?.[0]?.lastSeenAt?.gt ?? new Date(Date.now() - 30000);
        for (const p of participations.values()) {
          if (p.sessionId !== where.sessionId) continue;
          if (p.leftAt !== null) continue;
          if (p.joinRequestId && p.joinRequestStatus !== "ACCEPTED") continue;
          const isRecent = p.lastSeenAt && p.lastSeenAt > gt;
          const hasLease = Array.from(leases.values()).some(
            (l) => l.participationId === p.id && (!l.expiresAt || l.expiresAt > gt),
          );
          if (isRecent || hasLease) {
            count++;
          }
        }
        return count;
      },
    },
  };
}

function mockSessionsService(prisma) {
  const endedSessions = [];
  return {
    endedSessions,
    async endSessionBySystem(sessionId) {
      const session = prisma.sessions.get(sessionId);
      if (!session || session.status !== "LIVE") return null;
      session.status = "ENDED";
      session.endedAt = new Date();
      endedSessions.push(sessionId);
      return { session };
    },
  };
}

test("ClassSessionAutoCloseService defaults to 60,000ms (1 minute) empty timeout", () => {
  const prisma = mockPrisma();
  const sessions = mockSessionsService(prisma);
  const service = new ClassSessionAutoCloseService(prisma, sessions);

  assert.equal(service.getEmptyTimeoutMs(), 60000);

  service.setEmptyTimeoutMs(30000);
  assert.equal(service.getEmptyTimeoutMs(), 30000);
});

test("checkSession ignores sessions that are not LIVE (SCHEDULED, ENDED, CANCELLED)", async () => {
  const prisma = mockPrisma();
  const sessions = mockSessionsService(prisma);
  const service = new ClassSessionAutoCloseService(prisma, sessions);

  prisma.sessions.set("sched-1", { id: "sched-1", status: "SCHEDULED" });
  prisma.sessions.set("ended-1", { id: "ended-1", status: "ENDED" });
  prisma.sessions.set("cancel-1", { id: "cancel-1", status: "CANCELLED" });

  const schedResult = await service.checkSession("sched-1");
  assert.equal(schedResult, false);
  assert.equal(service.getEmptySince("sched-1"), undefined);

  const endedResult = await service.checkSession("ended-1");
  assert.equal(endedResult, false);
  assert.equal(service.getEmptySince("ended-1"), undefined);

  const cancelResult = await service.checkSession("cancel-1");
  assert.equal(cancelResult, false);
  assert.equal(service.getEmptySince("cancel-1"), undefined);

  assert.equal(sessions.endedSessions.length, 0);
});

test("checkSession starts timer when LIVE room has 0 participants, and cancels when participant rejoins", async () => {
  const prisma = mockPrisma();
  const sessions = mockSessionsService(prisma);
  const service = new ClassSessionAutoCloseService(prisma, sessions);
  const sessionId = "live-1";

  prisma.sessions.set(sessionId, { id: sessionId, status: "LIVE" });

  // 1. Initial check with 0 participants: starts countdown
  const t0 = new Date(1000000);
  const res1 = await service.checkSession(sessionId, t0);
  assert.equal(res1, false);
  assert.equal(service.getEmptySince(sessionId), 1000000);

  // 2. Check 30 seconds later (under 60s timeout): timer still running, not closed
  const t30 = new Date(1000000 + 30000);
  const res2 = await service.checkSession(sessionId, t30);
  assert.equal(res2, false);
  assert.equal(service.getEmptySince(sessionId), 1000000);
  assert.equal(sessions.endedSessions.length, 0);

  // 3. Participant rejoins at t40
  const partId = "p-1";
  prisma.participations.set(partId, {
    id: partId,
    sessionId,
    leftAt: null,
    lastSeenAt: new Date(1000000 + 40000),
    joinRequestId: null,
  });

  const t40 = new Date(1000000 + 40000);
  const res3 = await service.checkSession(sessionId, t40);
  assert.equal(res3, false);
  // Timer MUST be cancelled
  assert.equal(service.getEmptySince(sessionId), undefined);
  assert.equal(sessions.endedSessions.length, 0);

  // 4. Participant leaves at t50
  prisma.participations.get(partId).leftAt = new Date(1000000 + 50000);
  const t50 = new Date(1000000 + 50000);
  const res4 = await service.checkSession(sessionId, t50);
  assert.equal(res4, false);
  // New timer starts at t50
  assert.equal(service.getEmptySince(sessionId), 1000000 + 50000);

  // 5. Check at t50 + 59s: still not expired
  const t109 = new Date(1000000 + 50000 + 59000);
  const res5 = await service.checkSession(sessionId, t109);
  assert.equal(res5, false);
  assert.equal(sessions.endedSessions.length, 0);

  // 6. Check at t50 + 60s (exactly 1 minute elapsed): room closes!
  const t110 = new Date(1000000 + 50000 + 60000);
  const res6 = await service.checkSession(sessionId, t110);
  assert.equal(res6, true);
  assert.equal(service.getEmptySince(sessionId), undefined);
  assert.deepEqual(sessions.endedSessions, [sessionId]);
  assert.equal(prisma.sessions.get(sessionId).status, "ENDED");
});

test("sweep checks all LIVE sessions and cleans up non-LIVE entries", async () => {
  const prisma = mockPrisma();
  const sessions = mockSessionsService(prisma);
  const service = new ClassSessionAutoCloseService(prisma, sessions);
  service.setEmptyTimeoutMs(60000);

  const s1 = "live-1";
  const s2 = "live-2";
  const s3 = "ended-3";

  prisma.sessions.set(s1, { id: s1, status: "LIVE" });
  prisma.sessions.set(s2, { id: s2, status: "LIVE" });
  prisma.sessions.set(s3, { id: s3, status: "ENDED" });

  // Add active participant to s2
  prisma.participations.set("p-2", {
    id: "p-2",
    sessionId: s2,
    leftAt: null,
    lastSeenAt: new Date(),
    joinRequestId: null,
  });

  // First sweep: s1 is empty (starts countdown), s2 has participant (no countdown)
  await service.sweep();
  assert.ok(service.getEmptySince(s1) !== undefined);
  assert.equal(service.getEmptySince(s2), undefined);

  // Fast forward s1 emptySince to 60s ago
  const t0 = service.getEmptySince(s1);
  service.checkSession = async function (id, now) {
    if (id === s1) {
      // Simulate 61 seconds have passed
      const past = new Date(Date.now() + 61000);
      return ClassSessionAutoCloseService.prototype.checkSession.call(
        this,
        id,
        past,
      );
    }
    return ClassSessionAutoCloseService.prototype.checkSession.call(
      this,
      id,
      now,
    );
  };

  await service.sweep();
  assert.deepEqual(sessions.endedSessions, [s1]);
  assert.equal(prisma.sessions.get(s1).status, "ENDED");
});

test("endSessionBySystem aborts if a participant is active inside the transaction", async () => {
  let transactionWork;
  const fakeTx = {
    classSession: {
      findUnique: async () => ({ id: "s-active", status: "LIVE" }),
      update: async ({ data }) => ({ id: "s-active", ...data }),
    },
    $queryRaw: async () => [{ now: new Date() }],
    classParticipation: {
      count: async () => 1, // 1 active participant!
      updateMany: async () => {},
    },
    classJoinRequest: { updateMany: async () => {} },
    classSessionEndEvent: { create: async () => {} },
  };

  const fakePrisma = {
    $transaction: async (fn) => fn(fakeTx),
  };

  // Instantiate ClassSessionsService with minimal mocks
  const { ClassSessionsService } = require("../dist/modules/class-sessions/class-sessions.service");
  const sessionsService = new ClassSessionsService(fakePrisma, {}, {}, {});

  const result = await sessionsService.endSessionBySystem("s-active");
  assert.equal(result, null);
});

test("endSessionBySystem closes session when 0 active participants inside the transaction", async () => {
  let updatedSession = null;
  let endEventCreated = false;
  let participationsClosed = false;
  let joinRequestsExpired = false;

  const fakeTx = {
    classSession: {
      findUnique: async () => ({
        id: "s-empty",
        kind: "MEET",
        groupId: null,
        createdById: "u-1",
        title: "Test Meet",
        allowGuests: false,
        memberAdmission: "DIRECT",
        description: null,
        joinCode: "CODE12345678",
        status: "LIVE",
        startedAt: new Date(),
        endedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      update: async ({ data }) => {
        updatedSession = data;
        return {
          id: "s-empty",
          kind: "MEET",
          groupId: null,
          createdById: "u-1",
          title: "Test Meet",
          allowGuests: false,
          memberAdmission: "DIRECT",
          description: null,
          joinCode: "CODE12345678",
          status: data.status,
          startedAt: new Date(),
          endedAt: data.endedAt,
          cancelledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
    $queryRaw: async () => [{ now: new Date() }],
    classParticipation: {
      count: async () => 0, // 0 active participants!
      updateMany: async () => {
        participationsClosed = true;
      },
    },
    classJoinRequest: {
      updateMany: async () => {
        joinRequestsExpired = true;
      },
    },
    classSessionEndEvent: {
      create: async () => {
        endEventCreated = true;
      },
    },
  };

  const fakePrisma = {
    $transaction: async (fn) => fn(fakeTx),
  };

  const { ClassSessionsService } = require("../dist/modules/class-sessions/class-sessions.service");
  const sessionsService = new ClassSessionsService(fakePrisma, {}, {}, {});

  const result = await sessionsService.endSessionBySystem("s-empty");
  assert.ok(result);
  assert.equal(result.session.status, "ENDED");
  assert.ok(result.session.endedAt);
  assert.equal(updatedSession.status, "ENDED");
  assert.equal(endEventCreated, true);
  assert.equal(participationsClosed, true);
  assert.equal(joinRequestsExpired, true);
});
