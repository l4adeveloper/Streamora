import type { Prisma } from "../../generated/prisma/client";
import { verifiedClassMedia } from "../../database/class-presence";

type Tx = Prisma.TransactionClient;

/** A recorder that stops sending heartbeats no longer holds the recording. */
export const RECORDING_STALE_MS = 45000;
/** HTTP heartbeat freshness; server-verified IVS presence also keeps a screen active. */
const SCREEN_STALE_MS = 30000;
/** Uploads of long recordings can take a while; give up after two hours. */
const SAVING_STALE_MS = 2 * 60 * 60 * 1000;

// Serializes screen-share issuance with recording start for one session.
export async function lockScreenShares(tx: Tx, sessionId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 73012))::text`;
}

export function activeRecordingWhere(
  sessionId: string,
  now = new Date(),
): Prisma.ClassRecordingWhereInput {
  return {
    sessionId,
    status: "RECORDING",
    OR: [
      { provider: "IVS" },
      {
        provider: "BROWSER",
        lastSeenAt: { gte: new Date(now.getTime() - RECORDING_STALE_MS) },
      },
    ],
  };
}

// IVS tokens only bound joining, so liveness comes from heartbeats, not expiresAt.
export function liveScreenWhere(
  sessionId: string,
  now = new Date(),
): Prisma.ClassMediaConnectionWhereInput {
  return {
    sessionId,
    source: "SCREEN",
    OR: [
      {
        state: "ACTIVE",
        lastSeenAt: { gte: new Date(now.getTime() - SCREEN_STALE_MS) },
      },
      verifiedClassMedia(now),
      { state: "ISSUING", leaseUntil: { gt: now } },
    ],
  };
}

/** Earliest activation first: the first person who shared keeps the screen. */
export const screenShareOrder: Prisma.ClassMediaConnectionOrderByWithRelationInput[] =
  [
    { activatedAt: { sort: "asc", nulls: "last" } },
    { lastSeenAt: "asc" },
    { id: "asc" },
  ];

export async function recordingChanged(tx: Tx, sessionId: string) {
  await tx.$executeRaw`SELECT class_realtime_change(${sessionId}::uuid, 'recording.changed')`;
}

/** Fails recordings whose recorder disappeared so screen sharing is not blocked forever. */
export async function expireStaleRecordings(
  tx: Tx,
  sessionId: string,
  now = new Date(),
) {
  const abandoned = await tx.classRecording.updateMany({
    where: {
      sessionId,
      status: "RECORDING",
      provider: "BROWSER",
      lastSeenAt: { lt: new Date(now.getTime() - RECORDING_STALE_MS) },
    },
    data: { status: "FAILED", stoppedAt: now, version: { increment: 1 } },
  });
  const unsaved = await tx.classRecording.updateMany({
    where: {
      sessionId,
      status: "SAVING",
      provider: "BROWSER",
      stoppedAt: { lt: new Date(now.getTime() - SAVING_STALE_MS) },
    },
    data: { status: "FAILED", version: { increment: 1 } },
  });
  const count = abandoned.count + unsaved.count;
  if (count) await recordingChanged(tx, sessionId);
  return count;
}
