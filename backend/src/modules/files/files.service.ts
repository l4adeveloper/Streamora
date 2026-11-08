import { Injectable } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { FileResponse, FileStatus } from "@streamora/contracts";
import type {
  LibraryFile as DbFile,
  Prisma,
} from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { GroupAccessService } from "../memberships/group-access.service";
import { ApiError } from "../../common/api-error";
import { FileStorageService } from "./file-storage.service";
import { PREVIEW_TYPES } from "./file-preview";
import { VideoPlaybackService } from "./video-playback.service";
import type { FileListQueryDto } from "./files.dto";
import { presentFile as present } from "./file-presenter";

function cursorFor(file: DbFile, groupId: string, query: FileListQueryDto) {
  return Buffer.from(
    JSON.stringify({
      id: file.id,
      at: file.createdAt.toISOString(),
      groupId,
      q: query.q ?? "",
      type: query.type ?? "",
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
      c.type !== (query.type ?? "")
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
    const where: Prisma.LibraryFileWhereInput = {
      groupId,
      status: { not: "DELETED" },
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
    await this.prisma.$transaction(async (tx) => {
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
    });
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
}
