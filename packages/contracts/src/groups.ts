import type { CursorPage, PaginationRequest } from "./api";

// ─── Domain types ─────────────────────────────────────────────────────────────

export type GroupMemberRole = "OWNER" | "HOST" | "VIEWER";

export interface Group {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMember {
  userId: string;
  groupId: string;
  role: GroupMemberRole;
  joinedAt: string;
}

// ─── Request / Response ───────────────────────────────────────────────────────

export interface CreateGroupRequest {
  name: string;
  description?: string;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string | null;
}

export interface GroupResponse {
  group: Group;
}

export type GroupListResponse = CursorPage<Group>;

export interface GroupListRequest extends PaginationRequest {
  q?: string;
}

// ─── Error codes specific to groups ──────────────────────────────────────────

export type GroupErrorCode =
  | "GROUP_NOT_FOUND"
  | "GROUP_NAME_EXISTS"
  | "GROUP_NAME_REQUIRED"
  | "ACTIVE_SESSION"
  | "ALREADY_MEMBER"
  | "NOT_MEMBER"
  | "IDEMPOTENCY_CONFLICT";

// ─── Constraints ──────────────────────────────────────────────────────────────

export const GROUP_CONSTRAINTS = Object.freeze({
  nameMinLength: 1,
  nameMaxLength: 100,
  descriptionMaxLength: 500,
  searchMaxLength: 100,
});
