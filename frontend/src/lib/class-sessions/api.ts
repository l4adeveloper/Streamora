import "client-only";
import { apiRequest } from "@/lib/api";
import type {
  ClassAdmissionResponse,
  ClassBanEntry,
  ClassBanResponse,
  ClassMuteResponse,
  ClassPoll,
  ClassPollResponse,
  CreateClassPollRequest,
  CursorPage,
  ClassJoinRequestListResponse,
  ClassJoinRequestResponse,
  ClassParticipationListResponse,
  ClassParticipationResponse,
  ClassSessionListResponse,
  ClassSessionResponse,
  ClassSessionStatus,
  CreateGroupClassSessionRequest,
  CreateMeetRequest,
  MeetPreviewResponse,
  UpdateClassSessionRequest,
  ClassRecordingResponse,
  ClassRecordingStateResponse,
  UpdateClassRecordingLayoutRequest,
} from "@streamora/contracts";

const root = (id: string) => `/sessions/${encodeURIComponent(id)}`;
export const listClassPolls = (id: string, cursor?: string) =>
  apiRequest<CursorPage<ClassPoll>>(
    `${root(id)}/polls?${new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) })}`,
  );
export const createClassPoll = (id: string, body: CreateClassPollRequest) =>
  apiRequest<ClassPollResponse>(`${root(id)}/polls`, { method: "POST", body });
export const voteClassPoll = (id: string, optionId: string) =>
  apiRequest<ClassPollResponse>(`/polls/${encodeURIComponent(id)}/vote`, { method: "PUT", body: { optionId } });
export const closeClassPoll = (id: string) =>
  apiRequest<ClassPollResponse>(`/polls/${encodeURIComponent(id)}/close`, { method: "POST", body: {} });
const banPath = (id: string, userId: string) => `${root(id)}/bans/${encodeURIComponent(userId)}`;
export const muteClassParticipant = (id: string, userId: string, lock?: boolean) =>
  apiRequest<ClassMuteResponse>(`${root(id)}/participants/${encodeURIComponent(userId)}/mute`, {
    method: "POST",
    body: lock === undefined ? {} : { lock },
  });
export const banClassParticipant = (id: string, userId: string, reason?: string) =>
  apiRequest<ClassBanResponse>(banPath(id, userId), { method: "PUT", body: reason ? { reason } : {} });
export const unbanClassParticipant = (id: string, userId: string) =>
  apiRequest<void>(banPath(id, userId), { method: "DELETE" });
export const listClassBans = (id: string, cursor?: string) =>
  apiRequest<CursorPage<ClassBanEntry>>(
    `${root(id)}/bans?${new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) })}`,
  );
export function listClassSessions(
  groupId: string | null,
  cursor?: string,
  status?: ClassSessionStatus,
) {
  const query = new URLSearchParams({
    limit: "20",
    ...(cursor ? { cursor } : {}),
    ...(status ? { status } : {}),
  });
  return apiRequest<ClassSessionListResponse>(
    `${groupId ? `/groups/${encodeURIComponent(groupId)}/sessions` : "/meets"}?${query}`,
  );
}
export const getClassSession = (id: string) =>
  apiRequest<ClassSessionResponse>(root(id));
export const previewMeet = (code: string) =>
  apiRequest<MeetPreviewResponse>(`/meets/${encodeURIComponent(code)}`);
export const createGroupSession = (
  groupId: string,
  body: CreateGroupClassSessionRequest,
  key: string,
) =>
  apiRequest<ClassSessionResponse>(
    `/groups/${encodeURIComponent(groupId)}/sessions`,
    { method: "POST", body, idempotencyKey: key },
  );
export const createMeet = (body: CreateMeetRequest, key: string) =>
  apiRequest<ClassSessionResponse>("/meets", {
    method: "POST",
    body,
    idempotencyKey: key,
  });
export const updateClassSession = (
  id: string,
  body: UpdateClassSessionRequest,
) => apiRequest<ClassSessionResponse>(root(id), { method: "PATCH", body });
export const changeClassStatus = (
  id: string,
  action: "start" | "end" | "cancel",
  key: string,
) =>
  apiRequest<ClassSessionResponse>(`${root(id)}/${action}`, {
    method: "POST",
    body: {},
    idempotencyKey: key,
  });
export const getAdmission = (id: string) =>
  apiRequest<ClassAdmissionResponse>(`${root(id)}/admission`);
export const requestClassJoin = (id: string, key: string) =>
  apiRequest<ClassJoinRequestResponse>(`${root(id)}/join-requests`, {
    method: "POST",
    body: {},
    idempotencyKey: key,
  });
export const cancelClassJoin = (id: string, requestId: string) =>
  apiRequest<ClassJoinRequestResponse>(
    `${root(id)}/join-requests/${requestId}/cancel`,
    { method: "POST", body: {} },
  );
export const decideClassJoin = (
  id: string,
  requestId: string,
  decision: "ACCEPT" | "REJECT",
) =>
  apiRequest<ClassJoinRequestResponse>(
    `${root(id)}/join-requests/${requestId}`,
    { method: "PATCH", body: { decision } },
  );
export function listClassQueue(id: string, cursor?: string) {
  return apiRequest<ClassJoinRequestListResponse>(
    `${root(id)}/join-requests?${new URLSearchParams({ status: "PENDING", limit: "20", ...(cursor ? { cursor } : {}) })}`,
  );
}
export const enterClass = (id: string, key: string) =>
  apiRequest<ClassParticipationResponse>(`${root(id)}/enter`, {
    method: "POST",
    body: {},
    idempotencyKey: key,
  });
export const leaveClass = (id: string, visitId: string) =>
  apiRequest<ClassParticipationResponse>(
    `${root(id)}/participations/${visitId}/leave`,
    { method: "POST", body: {} },
  );
export const listClassParticipants = (id: string, cursor?: string) =>
  apiRequest<ClassParticipationListResponse>(
    `${root(id)}/participants?${new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) })}`,
  );
const recordingPath = (id: string, recordingId: string, action: string) =>
  `${root(id)}/recordings/${encodeURIComponent(recordingId)}/${action}`;
export const getClassRecording = (id: string) =>
  apiRequest<ClassRecordingStateResponse>(`${root(id)}/recording`);
export const startClassRecording = (id: string, participationId: string) =>
  apiRequest<ClassRecordingResponse>(`${root(id)}/recordings`, {
    method: "POST",
    body: { participationId },
  });
export const updateClassRecordingLayout = (
  id: string,
  recordingId: string,
  body: UpdateClassRecordingLayoutRequest,
) =>
  apiRequest<ClassRecordingResponse>(recordingPath(id, recordingId, "layout"), {
    method: "PATCH",
    body,
  });
export const heartbeatClassRecording = (id: string, recordingId: string) =>
  apiRequest<{ ok: true }>(recordingPath(id, recordingId, "heartbeat"), {
    method: "POST",
    body: {},
  });
export const stopClassRecording = (id: string, recordingId: string) =>
  apiRequest<ClassRecordingResponse>(recordingPath(id, recordingId, "stop"), {
    method: "POST",
    body: {},
  });
export const completeClassRecording = (id: string, recordingId: string, fileId: string) =>
  apiRequest<ClassRecordingResponse>(recordingPath(id, recordingId, "complete"), {
    method: "POST",
    body: { fileId },
  });
export const failClassRecording = (id: string, recordingId: string) =>
  apiRequest<ClassRecordingResponse>(recordingPath(id, recordingId, "fail"), {
    method: "POST",
    body: {},
  });
