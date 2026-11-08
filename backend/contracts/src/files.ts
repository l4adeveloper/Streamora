import type { CursorPage, PaginationRequest } from "./api";

export type FileStatus = "PENDING" | "AVAILABLE" | "DELETED";
export type FileSource = "DOCUMENT" | "LOCAL_RECORDING" | "CLOUD_RECORDING";
export interface LibraryFile {
  id: string;
  groupId: string;
  name: string;
  size: number;
  mimeType: string;
  source: FileSource;
  status: FileStatus;
  sessionId: string | null;
  recordingId: string | null;
  createdBy: string;
  createdAt: string;
}
export interface FileListQuery extends PaginationRequest {
  q?: string;
  type?: "document" | "video";
}
export type FileListResponse = CursorPage<LibraryFile>;
export interface FileResponse {
  file: LibraryFile;
}
export interface FileDownloadResponse {
  url: string;
  expiresAt: string;
}

export type VideoProcessingStatus =
  "NOT_REQUESTED" | "QUEUED" | "PROCESSING" | "READY" | "FAILED";
export interface VideoPlaybackSource extends FileDownloadResponse {
  id: string;
  label: string;
  kind: "file" | "hls";
  mimeType: string;
  height: number | null;
  bitrate: number | null;
}
export interface VideoPlaybackResponse {
  fileId: string;
  processing: { status: VideoProcessingStatus; progressPercent: number | null };
  sources: VideoPlaybackSource[];
}
