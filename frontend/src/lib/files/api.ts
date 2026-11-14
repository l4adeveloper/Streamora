import "client-only";
import type {
  FileDownloadResponse,
  FileListQuery,
  FileListResponse,
  FileResponse,
  FolderListResponse,
  FolderResponse,
  VideoPlaybackResponse,
  RecordingTranscriptResponse,
} from "@streamora/contracts";
import { apiRequest } from "@/lib/api";
export function listFiles(groupId: string, query: FileListQuery = {}) {
  const params = new URLSearchParams();
  if (query.folderPath) params.set("folderPath", query.folderPath);
  if (query.q) params.set("q", query.q);
  if (query.type) params.set("type", query.type);
  if (query.folderId !== undefined && query.folderId !== null) {
    params.set("folderId", query.folderId);
  }
  if (query.sessionId) params.set("sessionId", query.sessionId);
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

export function getRecordingTranscript(fileId: string) {
  return apiRequest<RecordingTranscriptResponse>(`/files/${fileId}/transcript`, {
    method: "GET",
  });
}

export function listFolders(groupId: string, parentId?: string | null) {
  const params = new URLSearchParams();
  if (parentId) params.set("parentId", parentId);
  return apiRequest<FolderListResponse>(
    `/groups/${groupId}/folders?${params}`,
    { method: "GET" },
  );
}

export function createFolder(
  groupId: string,
  name: string,
  parentId?: string | null,
) {
  return apiRequest<FolderResponse>(`/groups/${groupId}/folders`, {
    method: "POST",
    body: { name, parentId: parentId ?? undefined },
  });
}

export function renameFolder(
  folderIdOrGroupId: string,
  nameOrFolderPath: string,
  maybeName?: string,
  force = false,
) {
  if (maybeName !== undefined) {
    return apiRequest<void>(`/groups/${folderIdOrGroupId}/files/folders`, {
      method: "PATCH",
      body: { folderPath: nameOrFolderPath, name: maybeName, force },
    });
  }
  return apiRequest<FolderResponse>(`/folders/${folderIdOrGroupId}`, {
    method: "PATCH",
    body: { name: nameOrFolderPath },
  });
}

export function deleteFolder(
  folderIdOrGroupId: string,
  maybeFolderPath?: string,
  force = false,
) {
  if (maybeFolderPath !== undefined) {
    return apiRequest<void>(`/groups/${folderIdOrGroupId}/files/folders`, {
      method: "DELETE",
      body: { folderPath: maybeFolderPath, force },
    });
  }
  return apiRequest<void>(`/folders/${folderIdOrGroupId}`, {
    method: "DELETE",
  });
}

export function downloadFolder(groupId: string, folderPath: string) {
  return apiRequest<Blob>(`/groups/${groupId}/files/folders/download`, {
    method: "POST",
    body: { folderPath },
    responseType: "blob",
  });
}

export function moveFile(fileId: string, destinationFolderId: string | null) {
  return apiRequest<FileResponse>(`/files/${fileId}/move`, {
    method: "PATCH",
    body: { destinationFolderId },
  });
}

export function publishFile(fileId: string, isPublished = true) {
  return apiRequest<FileResponse>(`/files/${fileId}/publish`, {
    method: "PATCH",
    body: { isPublished },
  });
}
