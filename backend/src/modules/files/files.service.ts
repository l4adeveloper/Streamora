import { Injectable } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { FileResponse, FileStatus, FolderBreadcrumb, FolderListResponse, FolderResponse } from "@streamora/contracts";
import type {
  Folder as DbFolder,
  LibraryFile as DbFile,
  Prisma,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { GroupAccessService } from "../memberships/group-access.service";
import { ApiError } from "../../common/api-error";
import { safeErrorCode } from "../../common/safe-error-code";
import { FileStorageService } from "./file-storage.service";
import { PREVIEW_TYPES } from "./file-preview";
import { VideoPlaybackService } from "./video-playback.service";
import type { FileListQueryDto } from "./files.dto";
import { presentFile as present, presentFolder } from "./file-presenter";

function cursorFor(file: DbFile, groupId: string, query: FileListQueryDto) {
  return Buffer.from(
    JSON.stringify({
      id: file.id,
      at: file.createdAt.toISOString(),
      groupId,
      q: query.q ?? "",
      type: query.type ?? "",
      folderId: query.folderId ?? "",
    }),
  ).toString("base64url");
}
function readCursor(groupId: string, query: FileListQueryDto) {
  if (!query.cursor) return null;
  try {
    const c = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    );
    if (
      !isUUID(c.id) ||
      typeof c.at !== "string" ||
      new Date(c.at).toISOString() !== c.at ||
      c.groupId !== groupId ||
      c.q !== (query.q ?? "") ||
      c.type !== (query.type ?? "") ||
      (c.folderId !== undefined && c.folderId !== (query.folderId ?? ""))
    )
      throw new Error();
    return { id: c.id as string, at: new Date(c.at) };
  } catch {
    throw new ApiError(
      400,
      "INVALID_CURSOR",
      "Phân trang không hợp lệ. Hãy tải lại danh sách.",
    );
  }
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
    private readonly storage: FileStorageService,
    private readonly video: VideoPlaybackService,
  ) {}

  async list(userId: string, groupId: string, query: FileListQueryDto) {
    await this.access.require(userId, groupId);
    const cursor = readCursor(groupId, query);
    // Escape LIKE metacharacters: searching for '%' must not match every file.
    const name = (query.q ?? "").replace(/[\\%_]/g, "\\$&");
    const folderFilter =
      query.folderId !== undefined
        ? !query.folderId ||
          query.folderId === "root" ||
          query.folderId === "null"
          ? null
          : query.folderId
        : undefined;
    const where: Prisma.LibraryFileWhereInput = {
      groupId,
      status: { not: "DELETED" },
      ...(folderFilter !== undefined ? { folderId: folderFilter } : {}),
      ...(name ? { name: { contains: name, mode: "insensitive" } } : {}),
      ...(query.type === "video"
        ? { mimeType: { startsWith: "video/" } }
        : query.type === "document"
          ? { NOT: { mimeType: { startsWith: "video/" } } }
          : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.at } },
              { createdAt: cursor.at, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.libraryFile.findMany({
      where,
      take: query.limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(present),
      nextCursor:
        rows.length > query.limit
          ? cursorFor(page[page.length - 1], groupId, query)
          : null,
    };
  }
  private async authorized(
    userId: string,
    fileId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const file = await db.libraryFile.findUnique({ where: { id: fileId } });
    if (!file || file.status === "DELETED")
      throw new ApiError(
        404,
        "FILE_NOT_FOUND",
        "Tài liệu không tồn tại hoặc đã bị xóa.",
      );
    const permissions = await this.access.require(
      userId,
      file.groupId,
      undefined,
      db,
    );
    return { file, permissions };
  }
  async detail(userId: string, fileId: string): Promise<FileResponse> {
    return { file: present((await this.authorized(userId, fileId)).file) };
  }
  private async mutationAccess(
    tx: Prisma.TransactionClient,
    userId: string,
    fileId: string,
  ) {
    // Same group lock as membership mutations; then file lock for delete/pin races.
    const target = await tx.libraryFile.findUnique({
      where: { id: fileId },
      select: { groupId: true },
    });
    if (!target)
      throw new ApiError(404, "FILE_NOT_FOUND", "Không tìm thấy tài liệu.");
    await tx.$queryRaw`SELECT id FROM groups WHERE id = ${target.groupId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM files WHERE id = ${fileId}::uuid FOR UPDATE`;
    const current = await this.authorized(userId, fileId, tx);
    if (current.file.createdBy !== userId && !current.permissions.canHost)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn chỉ được quản lý tài liệu của mình.",
      );
    return current.file;
  }
  async rename(userId: string, fileId: string, name: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.mutationAccess(tx, userId, fileId);
      return {
        file: present(
          await tx.libraryFile.update({
            where: { id: fileId },
            data: { name },
          }),
        ),
      };
    });
  }
  async remove(userId: string, fileId: string) {
    const deletion = await this.prisma.$transaction(async (tx) => {
      const file = await this.mutationAccess(tx, userId, fileId);
      // PENDING can still be written by T16/T11. Recording links are retained
      // until T11 explicitly releases the recording retention/reference.
      if (
        file.status === "PENDING" ||
        file.recordingId ||
        (await tx.fileUsage.count({ where: { fileId } }))
      )
        throw new ApiError(
          409,
          "FILE_IN_USE",
          "Tài liệu đang được tải lên, xử lý hoặc liên kết với bản ghi.",
        );
      await tx.libraryFile.update({
        where: { id: fileId },
        data: { status: "DELETED", deletedAt: new Date() },
      });
      await tx.fileObjectDeletion.create({
        data: {
          fileId,
          objectKey: file.objectKey,
          storageLocationId: file.storageLocationId,
        },
      });
      return {
        objectKey: file.objectKey,
        storageLocationId: file.storageLocationId,
      };
    });
    // The durable deletion request is committed first; never hold DB locks for storage I/O.
    try {
      await this.storage.delete(deletion.objectKey, deletion.storageLocationId);
      await this.prisma.fileObjectDeletion.update({
        where: { fileId },
        data: { completedAt: new Date() },
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "file_delete_retry_pending",
          fileId,
          code: safeErrorCode(error),
        }),
      );
    }
  }
  async download(userId: string, fileId: string, preview = false) {
    const response = await this.withReadableFile(
      userId,
      fileId,
      async (file) => {
        if (preview && !PREVIEW_TYPES.has(file.mimeType))
          throw new ApiError(
            415,
            "PDF_PREVIEW_UNSUPPORTED",
            "Chỉ hỗ trợ xem trước PDF, ảnh và video tương thích.",
          );
        return this.storage.download(
          file.objectKey,
          file.name,
          preview,
          file.mimeType,
          file.storageLocationId,
        );
      },
    );
    console.info(
      JSON.stringify({
        event: preview ? "file_preview_issued" : "file_download_issued",
        fileId,
        userId,
        expiresAt: response.expiresAt,
      }),
    );
    return response;
  }
  playback(userId: string, fileId: string) {
    return this.withReadableFile(userId, fileId, (file, tx) =>
      this.video.manifest(file, tx),
    );
  }
  private async withReadableFile<T>(
    userId: string,
    fileId: string,
    work: (file: DbFile, tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    const file = await this.readableSnapshot(userId, fileId);
    const grant = await work(file, this.prisma); // No DB transaction/row lock during storage I/O.
    const current = await this.readableSnapshot(userId, fileId);
    if (
      current.objectKey !== file.objectKey ||
      current.storageLocationId !== file.storageLocationId
    )
      throw new ApiError(
        409,
        "FILE_CHANGED",
        "Vị trí file đã thay đổi. Hãy thử lại.",
      );
    return grant;
  }
  private readableSnapshot(userId: string, fileId: string) {
    // Short authorization snapshots before and after signing; no URL escapes on revocation.
    return this.prisma.$transaction(
      async (tx) => {
        const target = await tx.libraryFile.findUnique({
          where: { id: fileId },
          select: { groupId: true },
        });
        if (!target)
          throw new ApiError(404, "FILE_NOT_FOUND", "Không tìm thấy tài liệu.");
        await tx.$queryRaw`SELECT id FROM groups WHERE id = ${target.groupId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM files WHERE id = ${fileId}::uuid FOR SHARE`;
        const { file } = await this.authorized(userId, fileId, tx);
        if (file.status !== "AVAILABLE")
          throw new ApiError(
            409,
            "FILE_NOT_READY",
            "Tài liệu chưa sẵn sàng để tải.",
          );
        return file;
      },
      { timeout: 10000, maxWait: 5000 },
    );
  }
  // Trusted T11/worker boundary only. Not exposed as an HTTP route.
  async registerRecording(input: {
    recordingId: string;
    groupId: string;
    sourceObjectKey: string;
    size: number;
    mimeType: string;
    status: Exclude<FileStatus, "DELETED">;
    storageLocationId?: string;
  }) {
    if (
      !isUUID(input.recordingId) ||
      !isUUID(input.groupId) ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      !["PENDING", "AVAILABLE"].includes(input.status) ||
      !/^video\/[a-zA-Z0-9.+-]+$/.test(input.mimeType) ||
      !input.sourceObjectKey ||
      input.sourceObjectKey.length > 1024 ||
      /[\x00-\x1f]/.test(input.sourceObjectKey)
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Metadata bản ghi không hợp lệ.",
      );
    const storageLocationId =
      input.storageLocationId ?? (await this.storage.currentLocationId());
    if (storageLocationId)
      await this.storage.locations.resolve(storageLocationId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM recording_assets WHERE id = ${input.recordingId}::uuid FOR UPDATE`;
      const recording = await tx.recordingAsset.findUnique({
        where: { id: input.recordingId },
        include: { session: true },
      });
      if (!recording)
        throw new ApiError(
          404,
          "RECORDING_NOT_FOUND",
          "Không tìm thấy bản ghi.",
        );
      if (recording.session.groupId !== input.groupId)
        throw new ApiError(
          409,
          "GROUP_MISMATCH",
          "Bản ghi không thuộc nhóm này.",
        );
      const previous = await tx.libraryFile.findUnique({
        where: { recordingId: input.recordingId },
      });
      if (previous) {
        if (
          previous.objectKey !== input.sourceObjectKey ||
          previous.groupId !== input.groupId ||
          previous.status === "DELETED"
        )
          throw new ApiError(
            409,
            "RECORDING_CONFLICT",
            "Bản ghi đã được đăng ký với metadata khác.",
          );
        // Ignore late PENDING events after AVAILABLE. Keep user-renamed names.
        if (input.status === "AVAILABLE" && previous.status === "PENDING")
          await tx.libraryFile.update({
            where: { id: previous.id },
            data: {
              status: "AVAILABLE",
              size: BigInt(input.size),
              mimeType: input.mimeType,
            },
          });
        return { fileId: previous.id };
      }
      const file = await tx.libraryFile.create({
        data: {
          groupId: input.groupId,
          name: `${recording.session.title}.mp4`.slice(0, 255),
          objectKey: input.sourceObjectKey,
          size: BigInt(input.size),
          mimeType: input.mimeType,
          status: input.status,
          source: "CLOUD_RECORDING",
          recordingId: recording.id,
          sessionId: recording.sessionId,
          createdBy: recording.session.createdById,
          storageLocationId,
        },
      });
      return { fileId: file.id };
    });
  }

  async listFolders(
    userId: string,
    groupId: string,
    parentId?: string | null,
  ): Promise<FolderListResponse> {
    await this.access.require(userId, groupId);
    if (parentId === "all") {
      const all = await this.prisma.folder.findMany({
        where: { groupId, deletedAt: null },
        include: {
          _count: {
            select: {
              files: { where: { status: { not: "DELETED" } } },
              children: { where: { deletedAt: null } },
            },
          },
        },
        orderBy: { name: "asc" },
      });
      return {
        folders: all.map(presentFolder),
        breadcrumbs: [],
        currentFolder: null,
      };
    }
    const normalizedParentId =
      !parentId || parentId === "root" || parentId === "null"
        ? null
        : parentId;

    const folders = await this.prisma.folder.findMany({
      where: {
        groupId,
        parentId: normalizedParentId,
        deletedAt: null,
      },
      include: {
        _count: {
          select: {
            files: { where: { status: { not: "DELETED" } } },
            children: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    const breadcrumbs: FolderBreadcrumb[] = [];
    let currentFolder:
      | (DbFolder & { _count?: { files?: number; children?: number } })
      | null = null;
    let currId = normalizedParentId;
    while (currId) {
      const f = await this.prisma.folder.findFirst({
        where: { id: currId, groupId, deletedAt: null },
        include: {
          _count: {
            select: {
              files: { where: { status: { not: "DELETED" } } },
              children: { where: { deletedAt: null } },
            },
          },
        },
      });
      if (!f) break;
      if (!currentFolder) currentFolder = f;
      breadcrumbs.unshift({ id: f.id, name: f.name, parentId: f.parentId });
      currId = f.parentId;
    }

    return {
      folders: folders.map(presentFolder),
      breadcrumbs,
      currentFolder: currentFolder ? presentFolder(currentFolder) : null,
    };
  }

  async createFolder(
    userId: string,
    groupId: string,
    name: string,
    parentId?: string | null,
  ): Promise<FolderResponse> {
    const permissions = await this.access.require(userId, groupId);
    if (!permissions.canUpload && !permissions.canHost) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn không có quyền tạo thư mục trong nhóm này.",
      );
    }
    const normalizedParentId =
      !parentId || parentId === "root" || parentId === "null"
        ? null
        : parentId;

    if (normalizedParentId) {
      const parent = await this.prisma.folder.findFirst({
        where: { id: normalizedParentId, groupId, deletedAt: null },
      });
      if (!parent) {
        throw new ApiError(
          404,
          "PARENT_FOLDER_NOT_FOUND",
          "Thư mục cha không tồn tại hoặc đã bị xóa.",
        );
      }
    }

    const trimmedName = name.trim();
    const existing = await this.prisma.folder.findFirst({
      where: {
        groupId,
        parentId: normalizedParentId,
        name: trimmedName,
        deletedAt: null,
      },
    });
    if (existing) {
      throw new ApiError(
        409,
        "FOLDER_EXISTS",
        "Thư mục với tên này đã tồn tại ở vị trí hiện tại.",
      );
    }

    const created = await this.prisma.folder.create({
      data: {
        groupId,
        parentId: normalizedParentId,
        name: trimmedName,
        createdBy: userId,
      },
    });

    return { folder: presentFolder(created) };
  }

  async renameFolder(
    userId: string,
    folderId: string,
    name: string,
  ): Promise<FolderResponse> {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, deletedAt: null },
    });
    if (!folder) {
      throw new ApiError(404, "FOLDER_NOT_FOUND", "Thư mục không tồn tại.");
    }
    const permissions = await this.access.require(userId, folder.groupId);
    if (folder.createdBy !== userId && !permissions.canHost) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn chỉ được đổi tên thư mục do mình tạo.",
      );
    }

    const trimmedName = name.trim();
    const existing = await this.prisma.folder.findFirst({
      where: {
        groupId: folder.groupId,
        parentId: folder.parentId,
        name: trimmedName,
        deletedAt: null,
        id: { not: folderId },
      },
    });
    if (existing) {
      throw new ApiError(
        409,
        "FOLDER_EXISTS",
        "Thư mục với tên này đã tồn tại ở vị trí hiện tại.",
      );
    }

    const updated = await this.prisma.folder.update({
      where: { id: folderId },
      data: { name: trimmedName },
    });

    return { folder: presentFolder(updated) };
  }

  async removeFolder(userId: string, folderId: string): Promise<void> {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, deletedAt: null },
    });
    if (!folder) {
      throw new ApiError(404, "FOLDER_NOT_FOUND", "Thư mục không tồn tại.");
    }
    const permissions = await this.access.require(userId, folder.groupId);
    if (folder.createdBy !== userId && !permissions.canHost) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn chỉ được xóa thư mục do mình tạo.",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Find all descendant folders
      const toDelete: string[] = [folderId];
      const queue: string[] = [folderId];
      while (queue.length > 0) {
        const curr = queue.shift()!;
        const children = await tx.folder.findMany({
          where: { parentId: curr, deletedAt: null },
          select: { id: true },
        });
        for (const child of children) {
          toDelete.push(child.id);
          queue.push(child.id);
        }
      }

      const now = new Date();
      // Soft-delete the folders
      await tx.folder.updateMany({
        where: { id: { in: toDelete } },
        data: { deletedAt: now },
      });

      // Move files inside to parent folder (or root if parentId is null)
      await tx.libraryFile.updateMany({
        where: { folderId: { in: toDelete } },
        data: { folderId: folder.parentId },
      });
    });
  }

  async moveFile(
    userId: string,
    fileId: string,
    destinationFolderId: string | null,
  ): Promise<FileResponse> {
    return this.prisma.$transaction(async (tx) => {
      const file = await this.mutationAccess(tx, userId, fileId);

      if (destinationFolderId) {
        const dest = await tx.folder.findFirst({
          where: {
            id: destinationFolderId,
            groupId: file.groupId,
            deletedAt: null,
          },
        });
        if (!dest) {
          throw new ApiError(
            404,
            "DESTINATION_FOLDER_NOT_FOUND",
            "Thư mục đích không tồn tại hoặc đã bị xóa.",
          );
        }
      }

      const updated = await tx.libraryFile.update({
        where: { id: fileId },
        data: { folderId: destinationFolderId },
      });

      return { file: present(updated) };
    });
  }
}
