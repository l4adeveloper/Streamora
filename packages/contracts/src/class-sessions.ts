import type { CursorPage, PaginationRequest } from "./api";

export type ClassSessionKind = "GROUP" | "MEET";
export type ClassSessionStatus = "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";
export type ClassJoinRequestStatus =
  "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "EXPIRED" | "REVOKED";
export type ClassParticipationLeaveReason =
  "LEFT" | "DISCONNECTED" | "SESSION_ENDED" | "ACCESS_REVOKED";

interface ClassSessionBase {
  id: string;
  createdById: string;
  title: string;
  description: string | null;
  /** Discovery only; knowing the code never grants admission. */
  joinCode: string;
  status: ClassSessionStatus;
  /** All timestamp strings in these contracts are ISO8601 UTC. */
  startedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupClassSession extends ClassSessionBase {
  kind: "GROUP";
  groupId: string;
  scheduledAt: string;
}

export interface IndependentMeet extends ClassSessionBase {
  kind: "MEET";
  groupId: null;
  scheduledAt: string | null;
}

/** A class/meet session, distinct from an authentication session. */
export type ClassSession = GroupClassSession | IndependentMeet;

export interface ClassSessionUser {
  id: string;
  fullName: string;
}

/** Minimal discovery response before an independent meet admits the user. */
export interface MeetPreview {
  id: string;
  title: string;
  host: ClassSessionUser;
  status: ClassSessionStatus;
}

export interface ClassJoinRequest {
  id: string;
  sessionId: string;
  userId: string;
  status: ClassJoinRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedById: string | null;
  /** Set on cancellation, rejection, expiry or revocation; decisions are retained. */
  closedAt: string | null;
}

export interface ClassJoinRequestWithUser extends ClassJoinRequest {
  user: ClassSessionUser;
}

export interface ClassParticipation {
  id: string;
  sessionId: string;
  userId: string;
  /** Null when a manager entered directly. No media token is issued by T04. */
  joinRequestId: string | null;
  joinedAt: string;
  leftAt: string | null;
  leaveReason: ClassParticipationLeaveReason | null;
}

export interface ClassParticipationWithUser extends ClassParticipation {
  user: ClassSessionUser;
}

export interface CreateGroupClassSessionRequest {
  title: string;
  description?: string;
  scheduledAt: string;
}

export interface CreateMeetRequest {
  title: string;
  description?: string;
  scheduledAt?: string;
}

export interface UpdateClassSessionRequest {
  title?: string;
  description?: string | null;
  /** Clearing a schedule is allowed only for an independent meet. */
  scheduledAt?: string | null;
}

export interface ClassSessionListRequest extends PaginationRequest {
  status?: ClassSessionStatus;
}

export interface ClassJoinRequestListRequest extends PaginationRequest {
  status?: ClassJoinRequestStatus;
}

export interface DecideClassJoinRequest {
  decision: "ACCEPT" | "REJECT";
}

export interface ClassSessionResponse {
  session: ClassSession;
}
export type ClassSessionListResponse = CursorPage<ClassSession>;
export interface MeetPreviewResponse {
  meet: MeetPreview;
}
export interface ClassJoinRequestResponse {
  request: ClassJoinRequest;
}
export type ClassJoinRequestListResponse = CursorPage<ClassJoinRequestWithUser>;
export interface ClassParticipationResponse {
  participation: ClassParticipation;
}
export type ClassParticipationListResponse =
  CursorPage<ClassParticipationWithUser>;

export interface ClassSessionPermissions {
  canManage: boolean;
  canRequestJoin: boolean;
  canEnter: boolean;
  canViewParticipants: boolean;
}

/** Own admission state; does not expose the host's queue or other users. */
export interface ClassAdmissionResponse {
  request: ClassJoinRequest | null;
  participation: ClassParticipation | null;
  permissions: ClassSessionPermissions;
}

export const CLASS_SESSION_ENDED_EVENT = "session.ended.v1" as const;
export interface ClassSessionEndedEvent {
  eventId: string;
  sessionId: string;
  endedAt: string;
  /** Decimal bigint string to preserve ordering without JSON number rounding. */
  version: string;
}

/** Internal business event, separate from Socket.IO invalidations. */
export interface ClassSessionEndedMessage {
  type: typeof CLASS_SESSION_ENDED_EVENT;
  payload: ClassSessionEndedEvent;
}

/** Point-in-time server authorization; never a reusable admission or media token. */
export interface ClassSessionParticipantContext {
  session: {
    id: string;
    kind: ClassSessionKind;
    groupId: string | null;
    status: "LIVE";
  };
  userId: string;
  authSessionId: string;
  participationId: string;
  canManage: boolean;
  checkedAt: string;
}

export type ClassSessionErrorCode =
  | "INVALID_CURSOR"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_EDITABLE"
  | "SESSION_NOT_LIVE"
  | "INVALID_SESSION_STATE"
  | "JOIN_REQUEST_NOT_FOUND"
  | "JOIN_REQUEST_ALREADY_RESOLVED"
  | "JOIN_REQUEST_NOT_REQUIRED"
  | "ADMISSION_REQUIRED"
  | "ADMISSION_REVOKED"
  | "PARTICIPATION_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT";

export const CLASS_SESSION_CONSTRAINTS = Object.freeze({
  titleMinLength: 1,
  titleMaxLength: 100,
  descriptionMaxLength: 2000,
  joinCodeLength: 12,
});

export const CLASS_REALTIME_POLICY = Object.freeze({
  pollIntervalMs: 500,
  sweepIntervalMs: 1000,
  heartbeatIntervalMs: 10000,
  leaseTtlMs: 30000,
  maxWatches: 8,
});
export interface ClassRealtimeInvalidation {
  eventId: string;
  sessionId: string;
  version: string;
}
export interface ClassSessionWatchRequest {
  sessionId: string;
}
export interface ClassPresenceRequest {
  sessionId: string;
  participationId: string;
}
export interface ClassPresenceReceipt {
  participationId: string;
  serverTime: string;
  expiresAt: string;
}
export interface ClassWatchSnapshot {
  sessionId: string;
  admission: ClassAdmissionResponse;
  version: string;
  heartbeatIntervalMs: number;
  reconnectGraceMs: number;
}
export interface ClassParticipationClosed {
  sessionId: string;
  participationId: string;
  reason: ClassParticipationLeaveReason;
}
export type ClassRealtimeAck<T = Record<string, never>> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
