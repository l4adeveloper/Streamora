import type { Prisma } from "../generated/prisma/client";

type Tx = Prisma.TransactionClient;

/** Caller holds the matching group/session locks, or the disabled user's exclusive lock. */
export async function revokeClassAccess(
  tx: Tx,
  userId: string,
  now: Date,
  sessions: Prisma.ClassSessionWhereInput,
) {
  await tx.classJoinRequest.updateMany({
    where: {
      userId,
      session: sessions,
      status: { in: ["PENDING", "ACCEPTED"] },
    },
    data: { status: "REVOKED", closedAt: now },
  });
  await tx.classParticipation.updateMany({
    where: { userId, session: sessions, leftAt: null },
    data: { leftAt: now, leaveReason: "ACCESS_REVOKED" },
  });
}

/** User row must already be exclusively locked by SessionStore. */
export async function revokeDisabledClassAccess(
  tx: Tx,
  userId: string,
  now: Date,
) {
  const rows = await tx.classSession.findMany({
    where: {
      OR: [
        {
          joinRequests: {
            some: { userId, status: { in: ["PENDING", "ACCEPTED"] } },
          },
        },
        { participations: { some: { userId, leftAt: null } } },
      ],
    },
    select: { id: true, groupId: true },
    orderBy: { id: "asc" },
  });
  if (!rows.length) return;
  const groups = [
    ...new Set(rows.flatMap((row) => (row.groupId ? [row.groupId] : []))),
  ].sort();
  for (const id of groups)
    await tx.$queryRaw`SELECT id FROM groups WHERE id = ${id}::uuid FOR UPDATE`;
  for (const row of rows)
    await tx.$queryRaw`SELECT id FROM class_sessions WHERE id = ${row.id}::uuid FOR UPDATE`;
  await revokeClassAccess(tx, userId, now, {
    id: { in: rows.map((row) => row.id) },
  });
}
