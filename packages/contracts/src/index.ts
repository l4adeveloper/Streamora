export * from "./auth";
export * from "./api";

export type CommunityRole = "owner" | "teacher" | "member";
export type ChannelType = "text" | "voice" | "live";
export interface Community {
  id: string;
  name: string;
}
export interface Channel {
  id: string;
  communityId: string;
  name: string;
  type: ChannelType;
}
export interface Room {
  id: string;
  communityId: string;
  name: string;
  hostId: string;
  livekitRoomName: string;
}
export interface ChatMessage {
  id: string;
  channelId: string;
  senderId: string;
  text: string;
  createdAt: string;
}
export interface SharedFile {
  id: string;
  communityId: string;
  name: string;
  size: number;
  kind: "document" | "recording";
  status: "uploading" | "processing" | "ready" | "failed";
}
export interface TranscodeJob {
  recordingId: string;
  sourceKey: string;
  communityId: string;
  qualities: Array<720 | 1080>;
}
export interface MultipartUpload {
  uploadId: string;
  key: string;
  partSize: number;
  completedParts: Array<{ partNumber: number; etag: string }>;
}
