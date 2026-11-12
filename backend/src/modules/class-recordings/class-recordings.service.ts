import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  ClassRecording,
  ClassRecordingCameraPosition,
  ClassRecordingStateResponse,
  UpdateClassRecordingLayoutRequest,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import type {
  ClassRecording as RecordingRow,
  ClassSession,
  Prisma,
} from "../../generated/prisma/client";
import { ClassMediaService } from "../class-media/class-media.service";
import { ClassSessionAccessService } from "../class-sessions/class-session-access.service";
import {
  activeRecordingWhere,
  expireStaleRecordings,
  liveScreenWhere,
  lockScreenShares,
  recordingChanged,
  screenShareOrder,
} from "./screen-share-policy";

type Tx = Prisma.TransactionClient;
type Revocation = Awaited<ReturnType<ClassRecordingsService["revokeScreens"]>>;

const notFound = () =>
  new ApiError(404, "RECORDING_NOT_FOUND", "Không tìm thấy bản ghi của buổi học này.");
const notLive = () =>
  new ApiError(409, "SESSION_NOT_LIVE", "Buổi học chưa mở hoặc đã kết thúc.");

@Injectable()
export class ClassRecordingsService {
  private readonly logger = new Logger(ClassRecordingsService.name);
  constructor(
    private readonly db: PrismaService,
    private readonly access: ClassSessionAccessService,
    private readonly media: ClassMediaService,
  ) {}

  private async session(tx: Tx, userId: string, sessionId: string, manage: boolean) {
    await this.access.lockUsers(tx, [userId]);
    const session = await this.access.load(tx, sessionId, "share");
    await this.access.authorize(tx, userId, session, manage);
    return session;
  }

  private async view(tx: Tx, row: RecordingRow): Promise<ClassRecording> {
    const [recorder, screen] = await Promise.all([
      tx.user.findUniqueOrThrow({
        where: { id: row.recorderId },
        select: { fullName: true },
      }),
      row.status === "RECORDING"
        ? tx.classMediaConnection.findFirst({
            where: liveScreenWhere(row.sessionId),
            orderBy: screenShareOrder,
            select: {
              userId: true,
              participantId: true,
              user: { select: { fullName: true } },
            },
          })
        : null,
    ]);
    return {
      id: row.id,
      sessionId: row.sessionId,
      status: row.status as ClassRecording["status"],
      recorderId: row.recorderId,
      recorderName: recorder.fullName,
      startedAt: row.startedAt.toISOString(),
      stoppedAt: row.stoppedAt?.toISOString() ?? null,
      fileId: row.fileId,
      layout: {
        cameraPosition: row.cameraPosition as ClassRecordingCameraPosition,
        cameraVisible: row.cameraVisible,
      },
      presenter: screen
        ? {
            userId: screen.userId,
            fullName: screen.user.fullName,
            participantId: screen.participantId,
          }
        : null,
      version: row.version,
    };
  }

  private async current(tx: Tx, sessionId: string, recordingId: string) {
    const row = await tx.classRecording.findFirst({
      where: { id: recordingId, sessionId },
    });
    if (!row) throw notFound();
    return row;
  }

  async state(userId: string, sessionId: string): Promise<ClassRecordingStateResponse> {
    return this.db.$transaction(async (tx) => {
      const session = await this.session(tx, userId, sessionId, false);
      await expireStaleRecordings(tx, sessionId);
      const row = await tx.classRecording.findFirst({
        where: { sessionId, status: { in: ["RECORDING", "SAVING"] } },
        orderBy: { startedAt: "desc" },
      });
      return {
        recording: row ? await this.view(tx, row) : null,
        canRecord:
          session.status === "LIVE" &&
          !!session.groupId &&
          (await this.access.eligible(tx, userId, session)),
        groupId: session.groupId,
        title: session.title,
      };
    });
  }

  // Keep the first screen share; revoke the others inside the same transaction.
  private async revokeScreens(tx: Tx, sessionId: string) {
    const screens = await tx.classMediaConnection.findMany({
      where: liveScreenWhere(sessionId),
      orderBy: screenShareOrder,
      include: { room: { select: { stageArn: true } } },
    });
    const extra = screens.slice(1);
    if (extra.length)
      await tx.classMediaConnection.updateMany({
        where: { id: { in: extra.map((row) => row.id) } },
        data: {
          state: "REVOKING",
          tokenCiphertext: null,
          connected: false,
          checkedAt: new Date(),
        },
      });
    return extra;
  }

  private async disconnect(rows: Revocation) {
    // ClassMediaWorker retries any row left REVOKING after a provider failure.
    const results = await Promise.allSettled(
      rows.map(({ room, ...row }) => {
        if (!room.stageArn) throw new Error("MEDIA_STAGE_MISSING");
        return this.media.revoke({ ...row, state: "REVOKING" }, room.stageArn);
      }),
    );
    if (results.some(({ status }) => status === "rejected"))
      this.logger.warn(
        JSON.stringify({ event: "recording_screen_revoke_pending", count: rows.length }),
      );
  }

  async start(userId: string, sessionId: string, participationId: string) {
    const { recording, revoked } = await this.db.$transaction(async (tx) => {
      const session = await this.session(tx, userId, sessionId, true);
      if (session.status !== "LIVE") throw notLive();
      if (!session.groupId)
        throw new ApiError(
          409,
          "RECORDING_REQUIRES_GROUP",
          "Chỉ ghi hình được buổi học thuộc một nhóm để lưu vào thư viện.",
        );
      const visit = await this.access.activeVisit(tx, userId, session);
      if (!visit || visit.id !== participationId)
        throw new ApiError(
          409,
          "RECORDING_REQUIRES_PARTICIPATION",
          "Hãy vào phòng trước khi bắt đầu ghi hình.",
        );
      await lockScreenShares(tx, sessionId);
      await expireStaleRecordings(tx, sessionId);
      const active = await tx.classRecording.findFirst({
        where: activeRecordingWhere(sessionId),
      });
      if (active) {
        // Retrying start from the recorder keeps the same recording.
        if (active.recorderId === userId)
          return { recording: await this.view(tx, active), revoked: [] };
        throw new ApiError(
          409,
          "RECORDING_ACTIVE",
          "Buổi học đang được ghi hình bởi người khác.",
        );
      }
      const row = await tx.classRecording.create({
        data: { id: randomUUID(), sessionId, recorderId: userId },
      });
      const revoked = await this.revokeScreens(tx, sessionId);
      await recordingChanged(tx, sessionId);
      return { recording: await this.view(tx, row), revoked };
    });
    await this.disconnect(revoked);
    return { recording };
  }

  async layout(
    userId: string,
    sessionId: string,
    recordingId: string,
    dto: UpdateClassRecordingLayoutRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const session = await this.session(tx, userId, sessionId, false);
      const row = await this.current(tx, sessionId, recordingId);
      if (row.status !== "RECORDING")
        throw new ApiError(409, "RECORDING_NOT_ACTIVE", "Bản ghi đã dừng.");
      const presenting = await tx.classMediaConnection.findFirst({
        where: { ...liveScreenWhere(sessionId), userId },
        select: { id: true },
      });
      if (!presenting && !(await this.access.eligible(tx, userId, session)))
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Chỉ người đang chia sẻ màn hình hoặc người quản lý được đổi vị trí camera.",
        );
      const saved = await tx.classRecording.update({
        where: { id: row.id },
        data: {
          ...(dto.cameraPosition ? { cameraPosition: dto.cameraPosition } : {}),
          ...(dto.cameraVisible !== undefined ? { cameraVisible: dto.cameraVisible } : {}),
          version: { increment: 1 },
        },
      });
      await recordingChanged(tx, sessionId);
      return { recording: await this.view(tx, saved) };
    });
  }

  private async recorderRow(
    tx: Tx,
    userId: string,
    sessionId: string,
    recordingId: string,
    allowManager: boolean,
  ): Promise<{ session: ClassSession; row: RecordingRow }> {
    const session = await this.session(tx, userId, sessionId, false);
    const row = await this.current(tx, sessionId, recordingId);
    if (
      row.recorderId !== userId &&
      !(allowManager && (await this.access.eligible(tx, userId, session)))
    )
      throw new ApiError(403, "FORBIDDEN", "Bạn không phải người đang ghi hình.");
    return { session, row };
  }

  async heartbeat(userId: string, sessionId: string, recordingId: string) {
    return this.db.$transaction(async (tx) => {
      const { row } = await this.recorderRow(tx, userId, sessionId, recordingId, false);
      const saved = await tx.classRecording.updateMany({
        where: { id: row.id, ...activeRecordingWhere(sessionId) },
        data: { lastSeenAt: new Date() },
      });
      if (!saved.count)
        throw new ApiError(409, "RECORDING_NOT_ACTIVE", "Bản ghi đã dừng.");
      return { ok: true };
    });
  }

  async stop(userId: string, sessionId: string, recordingId: string) {
    return this.db.$transaction(async (tx) => {
      const { row } = await this.recorderRow(tx, userId, sessionId, recordingId, true);
      if (row.status !== "RECORDING") return { recording: await this.view(tx, row) };
      const saved = await tx.classRecording.update({
        where: { id: row.id },
        data: { status: "SAVING", stoppedAt: new Date(), version: { increment: 1 } },
      });
      await recordingChanged(tx, sessionId);
      return { recording: await this.view(tx, saved) };
    });
  }

  async complete(userId: string, sessionId: string, recordingId: string, fileId: string) {
    return this.db.$transaction(async (tx) => {
      const { session, row } = await this.recorderRow(
        tx,
        userId,
        sessionId,
        recordingId,
        false,
      );
      if (row.status === "SAVED") {
        if (row.fileId === fileId) return { recording: await this.view(tx, row) };
        throw new ApiError(409, "RECORDING_ALREADY_SAVED", "Bản ghi đã được lưu.");
      }
      // The upload pipeline creates the file; only the recorder's own session
      // recording can be linked, so a file of another group cannot be attached.
      const file = await tx.libraryFile.findUnique({ where: { id: fileId } });
      if (
        !file ||
        file.status !== "AVAILABLE" ||
        file.source !== "LOCAL_RECORDING" ||
        file.sessionId !== sessionId ||
        file.groupId !== session.groupId ||
        file.createdBy !== userId ||
        !file.mimeType.startsWith("video/")
      )
        throw new ApiError(
          409,
          "RECORDING_FILE_INVALID",
          "File bản ghi không hợp lệ hoặc chưa tải lên xong.",
        );
      const saved = await tx.classRecording.update({
        where: { id: row.id },
        data: {
          status: "SAVED",
          fileId,
          stoppedAt: row.stoppedAt ?? new Date(),
          version: { increment: 1 },
        },
      });
      await recordingChanged(tx, sessionId);
      return { recording: await this.view(tx, saved) };
    });
  }

  async fail(userId: string, sessionId: string, recordingId: string) {
    return this.db.$transaction(async (tx) => {
      const { row } = await this.recorderRow(tx, userId, sessionId, recordingId, false);
      if (!["RECORDING", "SAVING"].includes(row.status))
        return { recording: await this.view(tx, row) };
      const saved = await tx.classRecording.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          stoppedAt: row.stoppedAt ?? new Date(),
          version: { increment: 1 },
        },
      });
      await recordingChanged(tx, sessionId);
      return { recording: await this.view(tx, saved) };
    });
  }
}
