import { Injectable } from "@nestjs/common";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import { GroupAccessService } from "../memberships/group-access.service";
import { VideoProcessingService } from "../video-processing/video-processing.service";
import type { VideoOutput } from "../video-processing/video-policy";

@Injectable()
export class RecordingPlaybackService {
  constructor(
    private readonly db: PrismaService,
    private readonly access: GroupAccessService,
    private readonly processing: VideoProcessingService,
  ) {}

  async recording(userId: string, recordingId: string) {
    const row = await this.db.classRecording.findUnique({
      where: { id: recordingId },
      include: {
        session: { select: { groupId: true, title: true } },
        file: {
          select: {
            id: true,
            status: true,
            name: true,
            size: true,
            isPublished: true,
            createdBy: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!row?.session.groupId)
      throw new ApiError(404, "RECORDING_NOT_FOUND", "Không tìm thấy bản ghi.");
    const permissions = await this.access.require(
      userId,
      row.session.groupId,
      "canViewRecordings",
    );
    if (
      row.file &&
      (row.file.status === "DELETED" ||
        row.file.deletedAt ||
        (!row.file.isPublished &&
          !permissions.canHost &&
          row.file.createdBy !== userId))
    )
      throw new ApiError(403, "FORBIDDEN", "Bản ghi chưa được công bố.");
    return row;
  }

  async list(
    userId: string,
    groupId: string,
    limit = 20,
    cursor?: string,
    status?: string,
  ) {
    const permissions = await this.access.require(
      userId,
      groupId,
      "canViewRecordings",
    );
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(400, "VALIDATION_ERROR", "Limit phải từ 1 đến 100.");
    if (status && !["RECORDING", "SAVING", "SAVED", "FAILED"].includes(status))
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Trạng thái bản ghi không hợp lệ.",
      );
    let after: { id: string; at: Date } | undefined;
    if (cursor) {
      try {
        const value = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        );
        if (
          value.groupId !== groupId ||
          value.status !== (status ?? null) ||
          !/^[0-9a-f-]{36}$/i.test(value.id)
        )
          throw new Error();
        const at = new Date(value.at);
        if (!Number.isFinite(at.getTime())) throw new Error();
        after = { id: value.id, at };
      } catch {
        throw new ApiError(400, "INVALID_CURSOR", "Cursor không hợp lệ.");
      }
    }
    const rows = await this.db.classRecording.findMany({
      where: {
        session: { groupId },
        AND: [
          {
            OR: [
              { fileId: null },
              {
                file: {
                  status: { not: "DELETED" },
                  ...(permissions.canHost
                    ? {}
                    : { OR: [{ isPublished: true }, { createdBy: userId }] }),
                },
              },
            ],
          },
        ],
        ...(status ? { status } : {}),
        ...(after
          ? {
              OR: [
                { startedAt: { lt: after.at } },
                { startedAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: {
        session: { select: { title: true } },
        file: { select: { id: true, status: true, name: true } },
      },
    });
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        title: row.session.title,
        status: row.status,
        fileId: row.fileId,
        fileStatus: row.file?.status ?? null,
        startedAt: row.startedAt.toISOString(),
        stoppedAt: row.stoppedAt?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                id: rows[limit - 1].id,
                at: rows[limit - 1].startedAt.toISOString(),
                groupId,
                status: status ?? null,
              }),
            ).toString("base64url")
          : null,
    };
  }

  async detail(userId: string, recordingId: string) {
    const row = await this.recording(userId, recordingId);
    const progress = await this.progress(userId, recordingId);
    const state = row.fileId ? await this.processing.state(row.fileId) : null;
    const output =
      state?.published?.state === "READY"
        ? (state.published.output as unknown as VideoOutput)
        : null;
    return {
      recording: {
        id: row.id,
        sessionId: row.sessionId,
        groupId: row.session.groupId,
        title: row.session.title,
        status: row.status,
        fileId: row.fileId,
        fileStatus: row.file?.status ?? null,
        startedAt: row.startedAt.toISOString(),
        stoppedAt: row.stoppedAt?.toISOString() ?? null,
      },
      progress,
      renditions: Array.isArray(output?.renditions)
        ? output.renditions.map((rendition) => ({
            id: rendition.id,
            width: rendition.width,
            height: rendition.height,
            bitrate: rendition.bitrate,
            status: "READY" as const,
          }))
        : [],
      playbackPath:
        row.fileId && row.file?.status === "AVAILABLE"
          ? `/api/v1/recordings/${recordingId}/playback`
          : null,
      thumbnailResolverPath: `/api/v1/recordings/${recordingId}/thumbnail`,
    };
  }

  async progress(userId: string, recordingId: string) {
    await this.recording(userId, recordingId);
    const row = await this.db.recordingPlaybackProgress.findUnique({
      where: { recordingId_userId: { recordingId, userId } },
    });
    return {
      positionSeconds: row?.positionSeconds ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async saveProgress(
    userId: string,
    recordingId: string,
    positionSeconds: number,
    clientUpdatedAt: string,
  ) {
    const recording = await this.recording(userId, recordingId);
    const at = new Date(clientUpdatedAt);
    if (
      recording.status !== "SAVED" ||
      recording.file?.status !== "AVAILABLE" ||
      !recording.fileId
    )
      throw new ApiError(
        409,
        "PLAYBACK_NOT_READY",
        "Bản ghi chưa sẵn sàng để lưu tiến độ xem.",
      );
    const { published } = await this.processing.state(recording.fileId);
    const duration = (published?.output as { duration?: unknown } | null)
      ?.duration;
    if (
      !Number.isFinite(positionSeconds) ||
      positionSeconds < 0 ||
      positionSeconds > 100000000 ||
      (typeof duration === "number" &&
        Number.isFinite(duration) &&
        positionSeconds > duration) ||
      !Number.isFinite(at.getTime()) ||
      typeof clientUpdatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(clientUpdatedAt) ||
      at.getTime() > Date.now() + 60000
    )
      throw new ApiError(
        400,
        "INVALID_POSITION",
        "Vị trí hoặc thời điểm xem không hợp lệ.",
      );
    await this.db.$executeRaw`
      INSERT INTO recording_playback_progress (recording_id, user_id, position_seconds, client_updated_at, updated_at)
      VALUES (${recordingId}::uuid, ${userId}::uuid, ${positionSeconds}, ${at}, NOW())
      ON CONFLICT (recording_id, user_id) DO UPDATE
      SET position_seconds = EXCLUDED.position_seconds, client_updated_at = EXCLUDED.client_updated_at, updated_at = NOW()
      WHERE recording_playback_progress.client_updated_at <= EXCLUDED.client_updated_at`;
    return this.progress(userId, recordingId);
  }
}
