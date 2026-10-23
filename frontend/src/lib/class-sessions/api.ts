import "client-only";
import { apiRequest } from "@/lib/api";
import type {
  ClassAdmissionResponse,
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
} from "@streamora/contracts";

const root = (id: string) => `/sessions/${encodeURIComponent(id)}`;
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
