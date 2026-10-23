import "client-only";
import type {
  AssignableRole,
  GroupPermissions,
  MembershipListResponse,
  MembershipResponse,
  UserLookupResponse,
} from "@streamora/contracts";
import { apiRequest } from "@/lib/api";

export const getGroupPermissions = (groupId: string) =>
  apiRequest<GroupPermissions>(`/groups/${groupId}/permissions/me`);
export function listMembers(
  groupId: string,
  params: { q?: string; cursor?: string } = {},
) {
  const query = new URLSearchParams({ limit: "20", ...params });
  return apiRequest<MembershipListResponse>(
    `/groups/${groupId}/members?${query}`,
  );
}
export const lookupMember = (groupId: string, email: string) =>
  apiRequest<UserLookupResponse>(
    `/users/lookup?${new URLSearchParams({ groupId, email })}`,
  );
export const addMember = (
  groupId: string,
  userId: string,
  role: AssignableRole,
) =>
  apiRequest<MembershipResponse>(`/groups/${groupId}/members`, {
    method: "POST",
    body: { userId, role },
  });
export const changeMemberRole = (
  groupId: string,
  userId: string,
  role: AssignableRole,
) =>
  apiRequest<MembershipResponse>(`/groups/${groupId}/members/${userId}`, {
    method: "PATCH",
    body: { role },
  });
export const removeMember = (groupId: string, userId: string) =>
  apiRequest<void>(`/groups/${groupId}/members/${userId}`, {
    method: "DELETE",
  });
