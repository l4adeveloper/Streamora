import type {
  Prisma,
  ClassParticipation,
  ClassParticipationLeaveReason,
} from "../generated/prisma/client";
type Tx = Prisma.TransactionClient;

export async function classServerTime(tx: Tx) {
  const [clock] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  return clock.now;
}
export function validClassLease(
  now: Date,
): Prisma.ClassPresenceLeaseWhereInput {
  return {
    expiresAt: { gt: now },
    authSession: {
      revokedAt: null,
      expiresAt: { gt: now },
      user: { disabledAt: null },
    },
  };
}
/** Only server-side IVS reconciliation can provide this evidence of presence. */
export function verifiedClassMedia(
  now: Date,
): Prisma.ClassMediaConnectionWhereInput {
  return {
    state: "ACTIVE",
    connected: true,
    presenceVerifiedAt: { gt: new Date(now.getTime() - 30000) },
    authSession: {
      revokedAt: null,
      expiresAt: { gt: now },
      user: { disabledAt: null },
    },
  };
}
export async function classVisitCurrent(
  tx: Tx,
  visit: ClassParticipation,
  now: Date,
  ttlMs: number,
) {
  if (visit.leftAt) return false;
  if (visit.lastSeenAt.getTime() + ttlMs > now.getTime()) return true;
  if (
    await tx.classPresenceLease.findFirst({
      where: { participationId: visit.id, ...validClassLease(now) },
      select: { id: true },
    })
  )
    return true;
  return !!(await tx.classMediaConnection.findFirst({
    where: { participationId: visit.id, ...verifiedClassMedia(now) },
    select: { id: true },
  }));
}
/** Caller holds the parent group/session locks. Closing never affects a newer visit. */
export async function closeClassVisit(
  tx: Tx,
  visit: ClassParticipation,
  now: Date,
  reason: ClassParticipationLeaveReason,
) {
  if (visit.leftAt) return;
  if (visit.joinRequestId)
    await tx.classJoinRequest.updateMany({
      where: { id: visit.joinRequestId, status: "ACCEPTED" },
      data: {
        status: reason === "ACCESS_REVOKED" ? "REVOKED" : "EXPIRED",
        closedAt: now,
      },
    });
  await tx.classParticipation.updateMany({
    where: { id: visit.id, leftAt: null },
    data: { leftAt: now, leaveReason: reason },
  });
}
