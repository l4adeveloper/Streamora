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
