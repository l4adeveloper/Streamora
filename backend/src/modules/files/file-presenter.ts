import type { FolderItem, LibraryFile } from "@streamora/contracts";
import type {
  Folder as DbFolder,
  LibraryFile as DbFile,
} from "../../generated/prisma/client";

export function presentFile(file: DbFile): LibraryFile {
  return {
    id: file.id,
    groupId: file.groupId,
    folderId: file.folderId ?? null,
    name: file.name,
    size: Number(file.size),
    mimeType: file.mimeType,
    source: file.source,
    status: file.status,
    sessionId: file.sessionId,
    recordingId: file.recordingId,
    createdBy: file.createdBy,
    createdAt: file.createdAt.toISOString(),
  };
}

export function presentFolder(
  folder: DbFolder & { _count?: { files?: number; children?: number } },
): FolderItem {
  return {
    id: folder.id,
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
