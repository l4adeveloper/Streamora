import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type {
  LessonSummaryResponse,
  RecordingTranscriptCue,
} from "@streamora/contracts";
import { PrismaService } from "../../database/prisma.service";
import { GroupAccessService } from "../memberships/group-access.service";
import { FileStorageService } from "../files/file-storage.service";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { ApiError } from "../../common/api-error";
import type { Prisma } from "../../generated/prisma/client";
import {
  AzureLessonSummary,
  LESSON_SUMMARY_PROMPT,
  SUMMARY_PROMPT_VERSION,
  type SummaryPart,
} from "./azure-lesson-summary";

type Source = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  updatedAt: string;
  objectKey: string;
  storageLocationId: string | null;
  isPublished: boolean;
  cues: RecordingTranscriptCue[] | null;
};
// PostgreSQL JSONB reorders object keys. Fingerprints must compare values,
// not the serialization order returned by the database driver.
const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      ),
    )
    .digest("hex");
const isVideo = (mime: string) =>
  mime.startsWith("video/") || mime === "application/vnd.apple.mpegurl";
const textTypes = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
const binaryTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

@Injectable()
export class LessonFoldersService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly db: PrismaService,
    private readonly access: GroupAccessService,
    private readonly storage: FileStorageService,
    private readonly ai: AzureLessonSummary,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.azureOpenAI) return;
    this.timer = setInterval(() => void this.tick(), 3000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.flight;
  }

  private async folder(
    userId: string,
    folderId: string,
    manage = false,
    tx: Prisma.TransactionClient = this.db,
  ) {
    const folder = await tx.folder.findFirst({
      where: { id: folderId, deletedAt: null },
      include: { session: true },
    });
    if (!folder?.session)
      throw new ApiError(
        404,
        "LESSON_FOLDER_NOT_FOUND",
        "Không tìm thấy folder buổi học.",
      );
    const permissions = await this.access.require(
      userId,
      folder.groupId,
      manage ? "canHost" : undefined,
      tx,
    );
    return { folder, permissions };
  }

  async addMaterials(userId: string, folderId: string, fileIds: string[]) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM folders WHERE id = ${folderId}::uuid FOR UPDATE`;
      const { folder } = await this.folder(userId, folderId, true, tx);
      const count = await tx.libraryFile.count({
        where: {
          id: { in: fileIds },
          groupId: folder.groupId,
          status: "AVAILABLE",
          source: "DOCUMENT",
          summaryOutput: null,
        },
      });
      if (count !== fileIds.length)
        throw new ApiError(
          403,
          "MATERIAL_ACCESS_DENIED",
          "Chỉ thêm được tài liệu sẵn sàng trong đúng nhóm.",
        );
      await tx.libraryFile.updateMany({
        where: {
          id: { in: fileIds },
          groupId: folder.groupId,
          status: "AVAILABLE",
        },
        data: { folderId, folderPath: "" },
      });
      return { added: count };
    });
  }

  async read(
    userId: string,
    folderId: string,
    summaryId?: string,
  ): Promise<LessonSummaryResponse> {
    const { folder, permissions } = await this.folder(userId, folderId);
    const row = await this.db.lessonSummary.findFirst({
      where: {
        folderId,
        ...(summaryId ? { id: summaryId } : {}),
        ...(!permissions.canHost
          ? {
              status: "READY",
              resultFile: { isPublished: true, status: "AVAILABLE" as const },
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return {
      summary: row
        ? {
            id: row.id,
            folderId,
            status: row.status as "PENDING" | "PROCESSING" | "READY" | "FAILED",
            customPrompt: row.customPrompt,
            content: row.content,
            resultFileId: row.resultFileId,
            errorCode: row.errorCode,
            createdAt: row.createdAt.toISOString(),
          }
        : null,
      basePrompt: LESSON_SUMMARY_PROMPT,
      configured: !!this.config.azureOpenAI,
      sessionStatus: folder.session!.status,
    };
  }

  private async sources(
    folderId: string,
    db: Prisma.TransactionClient = this.db,
  ): Promise<Source[]> {
    const root = await db.folder.findFirst({
      where: { id: folderId, deletedAt: null },
    });
    if (!root)
      throw new ApiError(404, "LESSON_FOLDER_NOT_FOUND", "Folder đã bị xóa.");
    const ids = [folderId];
    for (let i = 0; i < ids.length; i++) {
      const children = await db.folder.findMany({
        where: { groupId: root.groupId, parentId: ids[i], deletedAt: null },
        select: { id: true },
      });
      for (const child of children)
        if (!ids.includes(child.id)) ids.push(child.id);
      if (ids.length > 100)
        throw new ApiError(
          413,
          "SUMMARY_TOO_LARGE",
          "Folder có quá nhiều thư mục con để tóm tắt.",
        );
    }
    const files = await db.libraryFile.findMany({
      where: {
        groupId: root.groupId,
        folderId: { in: ids },
        status: { not: "DELETED" },
        summaryOutput: null,
      },
      include: { videoTranscript: true },
      orderBy: { id: "asc" },
      take: 51,
    });
    if (!files.length)
      throw new ApiError(
        409,
        "SUMMARY_NO_SOURCES",
        "Thêm tài liệu hoặc chờ bản ghi được lưu vào folder trước.",
      );
    if (files.length > 50)
      throw new ApiError(
        413,
        "SUMMARY_TOO_LARGE",
        "Tối đa 50 tài liệu/bản ghi mỗi lần tóm tắt.",
      );
    let bytes = 0,
      characters = 0;
    return files.map((file) => {
      if (file.status !== "AVAILABLE")
        throw new ApiError(
          409,
          "SUMMARY_SOURCE_PENDING",
          "Có tài liệu đang được chuẩn bị. Vui lòng thử lại sau.",
        );
      const video = isVideo(file.mimeType);
      if (video && file.videoTranscript?.transcriptStatus !== "READY")
        throw new ApiError(
          409,
          "TRANSCRIPT_NOT_READY",
          `Bản chép lời của ${file.name} chưa sẵn sàng. Chờ xử lý phụ đề trước khi tóm tắt.`,
        );
      if (
        !video &&
        !textTypes.has(file.mimeType) &&
        !binaryTypes.has(file.mimeType)
      )
        throw new ApiError(
          415,
          "SUMMARY_UNSUPPORTED_FILE",
          `Chưa hỗ trợ đọc ${file.name}. Hãy chuyển tài liệu sang PDF hoặc văn bản.`,
        );
      const cues = video
        ? (file.videoTranscript!
            .transcriptCues as unknown as RecordingTranscriptCue[])
        : null;
      if (
        video &&
        (!Array.isArray(cues) ||
          cues.some(
            (cue) =>
              typeof cue.text !== "string" ||
              !Number.isFinite(cue.startMs) ||
              !Number.isFinite(cue.endMs),
          ))
      )
        throw new ApiError(
          409,
          "TRANSCRIPT_INVALID",
          "Bản chép lời chưa hợp lệ.",
        );
      if (cues)
        characters += cues.reduce((sum, cue) => sum + cue.text.length, 0);
      if (!video) bytes += Number(file.size);
      if (bytes > 18 * 1024 * 1024 || characters > 240000)
        throw new ApiError(
          413,
          "SUMMARY_TOO_LARGE",
          "Nguồn quá lớn cho một lần tóm tắt (18 MB tài liệu hoặc 240.000 ký tự transcript).",
        );
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: Number(file.size),
        updatedAt: file.updatedAt.toISOString(),
        objectKey: file.objectKey,
        storageLocationId: file.storageLocationId,
        isPublished: file.isPublished,
        cues,
      };
    });
  }

  async request(userId: string, folderId: string, customPrompt: string) {
    const config = this.config.azureOpenAI;
    await this.folder(userId, folderId, true);
    if (!config)
      throw new ApiError(
        503,
        "AI_NOT_CONFIGURED",
        "Chưa cấu hình Azure OpenAI cho tóm tắt buổi học.",
      );
    const summaryId = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM folders WHERE id = ${folderId}::uuid FOR UPDATE`;
        const { folder } = await this.folder(userId, folderId, true, tx);
        if (folder.session!.status !== "ENDED")
          throw new ApiError(
            409,
            "LESSON_NOT_ENDED",
            "Tạo tóm tắt sau khi buổi học đã kết thúc.",
          );
        if (
          await tx.classRecording.count({
            where: {
              sessionId: folder.sessionId!,
              status: { in: ["RECORDING", "SAVING"] },
            },
          })
        )
          throw new ApiError(
            409,
            "RECORDING_NOT_SAVED",
            "Bản ghi chưa lưu xong. Vui lòng chờ để tóm tắt đầy đủ.",
          );
        const inputs = await this.sources(folderId, tx);
        const inputHash = hash({
          inputs,
          customPrompt,
          model: config.deployment,
          version: SUMMARY_PROMPT_VERSION,
        });
        const active = await tx.lessonSummary.findFirst({
          where: { folderId, status: { in: ["PENDING", "PROCESSING"] } },
        });
        if (active && active.inputHash !== inputHash)
          throw new ApiError(
            409,
            "SUMMARY_IN_PROGRESS",
            "Folder đang được tóm tắt. Chờ hoàn tất trước khi gửi yêu cầu khác.",
          );
        const previous = await tx.lessonSummary.findUnique({
          where: { folderId_inputHash: { folderId, inputHash } },
          include: { resultFile: true },
        });
        if (
          previous &&
          (previous.status === "PENDING" ||
            previous.status === "PROCESSING" ||
            previous.resultFile?.status === "AVAILABLE")
        )
          return previous.id;
        const saved = await tx.lessonSummary.upsert({
          where: { folderId_inputHash: { folderId, inputHash } },
          create: {
            folderId,
            requestedBy: userId,
            customPrompt,
            inputHash,
            inputs: inputs as unknown as Prisma.InputJsonValue,
            deployment: config.deployment,
          },
          update: {
            requestedBy: userId,
            status: "PENDING",
            attempts: 0,
            leaseUntil: null,
            errorCode: null,
            content: null,
            resultFileId: null,
          },
        });
        return saved.id;
      },
      { timeout: 10000 },
    );
    return this.read(userId, folderId, summaryId);
  }

  tick(): Promise<void> {
    if (this.flight || !this.config.azureOpenAI || this.shutdown.signal.aborted)
      return this.flight ?? Promise.resolve();
    this.flight = this.process()
      .catch(() => {})
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }

  private async process() {
    const now = new Date();
    const row = await this.db.lessonSummary.findFirst({
      where: {
        status: { in: ["PENDING", "PROCESSING"] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!row) return;
    const lease = new Date(Date.now() + 4 * 60_000);
    const owned = {
      id: row.id,
      attempts: row.attempts + 1,
      leaseUntil: lease,
      status: "PROCESSING",
    };
    const claim = await this.db.lessonSummary.updateMany({
      where: {
        id: row.id,
        attempts: row.attempts,
        status: row.status,
        leaseUntil: row.leaseUntil,
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        leaseUntil: lease,
      },
    });
    if (!claim.count) return;
    let objectKey: string | undefined,
      location: string | null = null;
    try {
      if (row.attempts >= 3) throw new Error("AI_RETRY_EXHAUSTED");
      const { folder: lesson } = await this.folder(
        row.requestedBy,
        row.folderId,
        true,
      );
      const inputs = row.inputs as unknown as Source[];
      if (hash(await this.sources(row.folderId)) !== hash(inputs))
        throw new Error("SUMMARY_SOURCES_CHANGED");
      const signal = AbortSignal.any([
        this.shutdown.signal,
        AbortSignal.timeout(120000),
      ]);
      const parts: SummaryPart[] = [
        {
          type: "input_text",
          text: `Buổi học: ${lesson.session!.title}. Folder: ${lesson.name}.`,
        },
      ];
      for (const source of inputs) {
        signal.throwIfAborted();
        parts.push({
          type: "input_text",
          text: `Nguồn ID=${source.id}; tên=${source.name}; loại=${source.cues ? "TRANSCRIPT BẢN GHI" : "TÀI LIỆU THAM KHẢO"}`,
        });
        if (source.cues) {
          parts.push({
            type: "input_text",
            text:
              source.cues
                .map((c) => `[${c.startMs}-${c.endMs} ms] ${c.text}`)
                .join("\n") || "Không phát hiện lời nói trong bản ghi này.",
          });
          continue;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const stream = await this.storage.read(
          source.objectKey,
          source.storageLocationId,
          signal,
        );
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > source.size || size > 18 * 1024 * 1024) {
            stream.destroy();
            throw new Error("SUMMARY_SOURCES_CHANGED");
          }
          chunks.push(Buffer.from(chunk));
        }
        if (size !== source.size) throw new Error("SUMMARY_SOURCES_CHANGED");
        const data = Buffer.concat(chunks);
        if (textTypes.has(source.mimeType)) {
          if (data.length > 240000) throw new Error("SUMMARY_TOO_LARGE");
          parts.push({ type: "input_text", text: data.toString("utf8") });
        } else if (source.mimeType === "application/pdf")
          parts.push({
            type: "input_file",
            filename: source.name,
            file_data: `data:application/pdf;base64,${data.toString("base64")}`,
          });
        else
          parts.push({
            type: "input_image",
            image_url: `data:${source.mimeType};base64,${data.toString("base64")}`,
          });
      }
      await this.folder(row.requestedBy, row.folderId, true);
      const result = await this.ai.generate(parts, row.customPrompt, signal);
      const ids = new Set(inputs.map((input) => input.id));
      if (result.sourceIds.some((id) => !ids.has(id)))
        throw new Error("AI_INVALID_OUTPUT");
      const content = `# ${result.title}\n\n${result.markdown}\n\n---\nTóm tắt bằng AI; hãy đối chiếu với bản ghi và tài liệu gốc.\n\nNguồn:\n${inputs.map((s) => `- ${s.name}`).join("\n")}\n`;
      objectKey = `groups/${lesson.groupId}/summaries/${row.folderId}/${row.id}/${randomUUID()}.md`;
      location = await this.storage.currentLocationId();
      await this.storage.writeText(objectKey, content, location);
      await this.db.$transaction(
        async (tx) => {
          const { folder } = await this.folder(
            row.requestedBy,
            row.folderId,
            true,
            tx,
          );
          if (hash(await this.sources(row.folderId, tx)) !== hash(inputs))
            throw new Error("SUMMARY_SOURCES_CHANGED");
          const current = await tx.lessonSummary.findFirst({ where: owned });
          if (!current) throw new Error("SUMMARY_LEASE_LOST");
          const published = inputs.every((input) => input.isPublished);
          const file = await tx.libraryFile.create({
            data: {
              groupId: folder.groupId,
              folderId: folder.id,
              sessionId: folder.sessionId,
              name: `Tóm tắt — ${folder.name}`.slice(0, 240) + ".md",
              size: Buffer.byteLength(content),
              mimeType: "text/markdown",
              source: "DOCUMENT",
              status: "AVAILABLE",
              objectKey: objectKey!,
              storageLocationId: location,
              createdBy: row.requestedBy,
              isPublished: published,
              publishedAt: published ? new Date() : null,
            },
          });
          await tx.lessonSummary.update({
            where: { id: row.id },
            data: {
              status: "READY",
              content,
              resultFileId: file.id,
              errorCode: null,
              completedAt: new Date(),
              leaseUntil: null,
            },
          });
        },
        { timeout: 10000 },
      );
      objectKey = undefined;
    } catch (error) {
      if (objectKey)
        await this.storage.delete(objectKey, location).catch(() => {});
      const message = error instanceof Error ? error.message : "";
      const code =
        error instanceof ApiError && [401, 403].includes(error.getStatus())
          ? "SUMMARY_ACCESS_REVOKED"
          : /^[A-Z][A-Z0-9_]{2,63}$/.test(message)
            ? message
            : "AI_TEMPORARY_FAILURE";
      const retry =
        ["AI_TEMPORARY_FAILURE", "AI_RATE_LIMITED"].includes(code) &&
        row.attempts < 2;
      await this.db.lessonSummary.updateMany({
        where: owned,
        data: {
          status: retry ? "PENDING" : "FAILED",
          errorCode: code,
          leaseUntil: retry
            ? new Date(Date.now() + (row.attempts + 1) * 30000)
            : null,
        },
      });
    }
  }
}
