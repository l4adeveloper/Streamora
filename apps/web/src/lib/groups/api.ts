import "client-only";
import type {
  Group,
  GroupResponse,
  GroupListResponse,
  CreateGroupRequest,
  UpdateGroupRequest,
} from "@streamora/contracts";
import { apiRequest } from "@/lib/api";

export type { Group, GroupResponse, GroupListResponse };

// ─── T02-01: Tạo group ────────────────────────────────────────────────────────

export async function createGroup(data: CreateGroupRequest): Promise<GroupResponse> {
  return apiRequest<GroupResponse>("/groups", {
    method: "POST",
    body: data,
  });
}

// ─── T02-02: Danh sách group ──────────────────────────────────────────────────

export async function listGroups(params?: {
  q?: string;
  cursor?: string;
  limit?: number;
}): Promise<GroupListResponse> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.limit) qs.set("limit", String(params.limit));
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest<GroupListResponse>(`/groups${query}`, { method: "GET" });
}

// ─── T02-03: Chi tiết group ───────────────────────────────────────────────────

export async function getGroup(groupId: string): Promise<GroupResponse> {
  return apiRequest<GroupResponse>(`/groups/${groupId}`, { method: "GET" });
}

// ─── T02-04: Sửa group ────────────────────────────────────────────────────────

export async function updateGroup(
  groupId: string,
  data: UpdateGroupRequest,
): Promise<GroupResponse> {
  return apiRequest<GroupResponse>(`/groups/${groupId}`, {
    method: "PATCH",
    body: data,
  });
}

// ─── T02-05: Xóa mềm group ───────────────────────────────────────────────────

export async function deleteGroup(groupId: string): Promise<void> {
  await apiRequest<void>(`/groups/${groupId}`, { method: "DELETE" });
}
