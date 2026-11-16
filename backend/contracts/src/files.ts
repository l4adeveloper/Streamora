import type { CursorPage, PaginationRequest } from "./api";

export type FileStatus = "PENDING" | "AVAILABLE" | "DELETED";
export type FileSource = "DOCUMENT" | "LOCAL_RECORDING" | "CLOUD_RECORDING";
export interface LibraryFile {
  id: string;
  groupId: string;
  folderId?: string | null;
  folderName?: string | null;
  name: string;
  folderPath: string;
  size: number;
  mimeType: string;
  source: FileSource;
  status: FileStatus;
  sessionId: string | null;
  recordingId: string | null;
  createdBy: string;
  createdAt: string;
  isPublished: boolean;
  publishedAt: string | null;
  canDownload?: boolean;
}
export interface PublishFileRequest {
  isPublished?: boolean;
}
export interface FileListQuery extends PaginationRequest {
  folderPath?: string;
  q?: string;
  type?: "document" | "video";
  folderId?: string | null;
  sessionId?: string;
}
export type FileListResponse = CursorPage<LibraryFile> & { folders: string[] };
export interface FileResponse {
  file: LibraryFile;
}
export interface FileDownloadResponse {
  url: string;
  expiresAt: string;
}

export interface FolderItem {
  kind?: "REGULAR" | "LESSON";
  sessionId?: string | null;
  id: string;
  groupId: string;
  parentId: string | null;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  fileCount?: number;
  folderCount?: number;
}

export interface LessonSummary {
  id: string;
  folderId: string;
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  customPrompt: string;
  content: string | null;
  resultFileId: string | null;
  errorCode: string | null;
  createdAt: string;
}
export interface LessonSummaryResponse {
  summary: LessonSummary | null;
  basePrompt: string;
  configured: boolean;
  sessionStatus: string;
}

export interface FolderBreadcrumb {
  id: string;
  name: string;
  parentId: string | null;
}

export interface CreateFolderRequest {
  name: string;
  parentId?: string | null;
}

export interface RenameFolderRequest {
  name: string;
}

export interface MoveFileRequest {
  destinationFolderId: string | null;
}

export interface FolderListResponse {
  folders: FolderItem[];
  breadcrumbs: FolderBreadcrumb[];
  currentFolder: FolderItem | null;
}

export interface FolderResponse {
  folder: FolderItem;
}

export type VideoProcessingStatus =
  "NOT_REQUESTED" | "QUEUED" | "PROCESSING" | "READY" | "FAILED";
export interface VideoPlaybackSource extends FileDownloadResponse {
  public?: boolean;
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
  qualities?: VideoQuality[];
  thumbnail?: string;
}
export interface VideoQuality extends FileDownloadResponse {
  id: string;
  width: number;
  height: number;
  bitrate: number;
  label: string;
}
export interface VideoProcessingResponse {
  status: VideoProcessingStatus;
  progressPercent: number | null;
  renditions: { height: number; bitrate: number; status: "READY" }[];
  thumbnailReady: boolean;
  errorCode?: string;
}
