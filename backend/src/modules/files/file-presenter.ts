import type { FolderItem, LibraryFile } from "@streamora/contracts";
import type {
  Folder as DbFolder,
  LibraryFile as DbFile,
} from "../../generated/prisma/client";

export function presentFile(
  file: DbFile & { folder?: { name: string } | null },
): LibraryFile {
  return {
    id: file.id,
    groupId: file.groupId,
    folderId: file.folderId ?? null,
    folderName:
      file.folder?.name ??
      (file.folderPath && file.folderPath !== "/"
        ? file.folderPath.split("/").filter(Boolean).pop() ?? null
        : null),
    name: file.name,
    folderPath: file.folderPath,
    size: Number(file.size),
    mimeType: file.mimeType,
    canDownload: file.mimeType !== "application/vnd.apple.mpegurl",
    source: file.source,
    status: file.status,
    sessionId: file.sessionId,
    recordingId: file.recordingId,
    createdBy: file.createdBy,
    createdAt: file.createdAt.toISOString(),
    isPublished: file.isPublished,
    publishedAt: file.publishedAt ? file.publishedAt.toISOString() : null,
  };
}

export function presentFolder(
  folder: DbFolder & { _count?: { files?: number; children?: number } },
): FolderItem {
  return {
    id: folder.id,
    kind: folder.sessionId ? "LESSON" : "REGULAR",
    sessionId: folder.sessionId ?? null,
    groupId: folder.groupId,
    parentId: folder.parentId ?? null,
    name: folder.name,
    createdBy: folder.createdBy,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
    fileCount: folder._count?.files,
    folderCount: folder._count?.children,
  };
}
