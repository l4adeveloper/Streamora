import type { CursorPage } from "./api";

export type MembershipRole = "OWNER" | "HOST" | "VIEWER";
export type AssignableRole = Exclude<MembershipRole, "OWNER">;
export interface Membership {
  userId: string;
  fullName: string;
  email: string;
  role: MembershipRole;
  joinedAt: string;
}
export interface GroupPermissions {
  role: MembershipRole | "ADMIN";
  canManageMembers: boolean;
  canHost: boolean;
  canUpload: boolean;
  canViewRecordings: boolean;
}
export type GroupPermission = Exclude<keyof GroupPermissions, "role">;
export interface MembershipResponse {
  membership: Membership;
}
export type MembershipListResponse = CursorPage<Membership>;
export interface UserLookupResponse {
  user: { id: string; fullName: string; email: string } | null;
}
export interface MembershipChanged {
  groupId: string;
  userId: string;
  role: AssignableRole | null;
  removed: boolean;
  // Decimal string: a PostgreSQL bigint must never be rounded by JSON/JS.
  version: string;
}
