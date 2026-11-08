import type { LibraryFile } from "@streamora/contracts";
import type { LibraryFile as DbFile } from "../../generated/prisma/client";
export function presentFile(file: DbFile): LibraryFile {
  return {
    id: file.id,
    groupId: file.groupId,
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
