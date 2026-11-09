import "client-only";
import type {
  FileDownloadResponse,
  FileListQuery,
  FileListResponse,
  FileResponse,
  VideoPlaybackResponse,
} from "@streamora/contracts";
import { apiRequest } from "@/lib/api";
export function listFiles(groupId: string, query: FileListQuery = {}) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.type) params.set("type", query.type);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  return apiRequest<FileListResponse>(`/groups/${groupId}/files?${params}`, {
    method: "GET",
  });
}
export function getFile(fileId: string) {
  return apiRequest<FileResponse>(`/files/${fileId}`, { method: "GET" });
}
export function renameFile(fileId: string, name: string) {
  return apiRequest<FileResponse>(`/files/${fileId}`, {
    method: "PATCH",
    body: { name },
  });
}
export function deleteFile(fileId: string) {
  return apiRequest<void>(`/files/${fileId}`, { method: "DELETE" });
}
export function getFileDownload(fileId: string) {
  return apiRequest<FileDownloadResponse>(`/files/${fileId}/download-url`, {
    method: "POST",
    body: {},
  });
}
export function getFilePreview(fileId: string) {
  return apiRequest<FileDownloadResponse>(`/files/${fileId}/preview-url`, {
    method: "POST",
    body: {},
  });
}
export function getVideoPlayback(fileId: string) {
  return apiRequest<VideoPlaybackResponse>(`/files/${fileId}/playback`, {
    method: "POST",
    body: {},
  });
}
