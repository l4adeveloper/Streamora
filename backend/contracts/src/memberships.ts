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

export interface GroupChatMessage {
  id: string;
  clientId: string | null;
  groupId: string;
  senderId: string;
  senderName: string;
  senderRole: MembershipRole | "ADMIN";
  channel: string;
  text: string;
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
}

export interface GroupChatChannel {
  id: string;
  groupId: string;
  name: string;
  createdById: string;
  createdAt: string;
}

export type GroupChatJoinAck =
  | {
      ok: true;
      groupId: string;
      channel: string;
      messages: GroupChatMessage[];
      channels: GroupChatChannel[];
    }
  | { ok: false; error: { code: string; message: string } };

export type GroupChatSendAck =
  | { ok: true; id: string }
  | { ok: false; error: { code: string; message: string } };

export type GroupChatActionAck = GroupChatSendAck;

export type GroupChatChannelAck =
  | { ok: true; channel: GroupChatChannel }
  | { ok: false; error: { code: string; message: string } };

export interface GroupChatDeleted {
  id: string;
  groupId: string;
  channel: string;
}
