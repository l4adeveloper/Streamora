import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { safeErrorCode } from "../../common/safe-error-code";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import { FileStorageService } from "../files/file-storage.service";
import {
  transcribeRecording,
  TranscriptionInputError,
} from "./azure-speech-transcriber";

const maxAttempts = 3;
// The Speech SDK can send prerecorded audio at real-time speed.
const workTimeoutMs = (120 + 15) * 60_000;
const leaseMs = workTimeoutMs + 60_000;

@Injectable()
export class RecordingTranscriptWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RecordingTranscriptWorker.name);
  private readonly shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(
    private readonly db: PrismaService,
    private readonly storage: FileStorageService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}

  onApplicationBootstrap() {
    const config = this.config.azureSpeech;
    if (!config) {
      this.logger.log("Video transcription is disabled.");
      return;
    }
    this.logger.log(
      `Video transcription enabled for Azure region ${config.region}.`,
    );
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    this.shutdown.abort();
  }

  async tick() {
    const config = this.config.azureSpeech;
    if (!config || this.busy || this.shutdown.signal.aborted) return;
    this.busy = true;
    try {
      const row = await this.db.videoTranscript.findFirst({
        where: {
          file: { status: "AVAILABLE" },
          transcriptStatus: { in: ["PENDING", "PROCESSING"] },
          transcriptNextAttemptAt: { lte: new Date() },
        },
        orderBy: { transcriptNextAttemptAt: "asc" },
        include: {
          file: { select: { objectKey: true, storageLocationId: true } },
        },
      });
      if (!row || this.shutdown.signal.aborted) return;
      const claim = {
        fileId: row.fileId,
        transcriptStatus: row.transcriptStatus,
        transcriptAttempts: row.transcriptAttempts,
        transcriptNextAttemptAt: row.transcriptNextAttemptAt,
      };
      if (row.transcriptAttempts >= maxAttempts) {
        await this.db.videoTranscript.updateMany({
          where: claim,
          data: { transcriptStatus: "FAILED" },
        });
        return;
      }
      const attempt = row.transcriptAttempts + 1;
      const leaseUntil = new Date(Date.now() + leaseMs);
      const { count } = await this.db.videoTranscript.updateMany({
        where: claim,
        data: {
          transcriptStatus: "PROCESSING",
          transcriptAttempts: attempt,
          transcriptNextAttemptAt: leaseUntil,
        },
      });
      if (!count) return;
      this.logger.log(
        `Video transcript for file ${row.fileId} started attempt ${attempt}.`,
      );

      // The attempt and lease fence writes after a crashed worker's lease expires.
      const owned = {
        fileId: row.fileId,
        transcriptStatus: "PROCESSING" as const,
        transcriptAttempts: attempt,
        transcriptNextAttemptAt: leaseUntil,
      };
      try {
        const signal = AbortSignal.any([
          this.shutdown.signal,
          AbortSignal.timeout(workTimeoutMs),
        ]);
        const cues = await transcribeRecording(
          config,
          this.storage,
          row.file,
          signal,
        );
        const result = await this.db.videoTranscript.updateMany({
          where: owned,
          data: {
            transcriptStatus: "READY",
            transcriptCues: cues.map((cue) => ({ ...cue })),
          },
        });
        if (result.count)
          this.logger.log(
            `Video transcript for file ${row.fileId} is ready with ${cues.length} cues.`,
          );
      } catch (error) {
        if (this.shutdown.signal.aborted) {
          await this.db.videoTranscript.updateMany({
            where: owned,
            data: {
              transcriptStatus: "PENDING",
              transcriptAttempts: row.transcriptAttempts,
              transcriptNextAttemptAt: new Date(),
            },
          });
          return;
        }
        const status =
          error instanceof TranscriptionInputError
            ? error.status
            : attempt >= maxAttempts
              ? "FAILED"
              : "PENDING";
        await this.db.videoTranscript.updateMany({
          where: owned,
          data: {
            transcriptStatus: status,
            transcriptNextAttemptAt: new Date(Date.now() + attempt * 60_000),
          },
        });
        this.logger.warn(
          `Video transcript for file ${row.fileId} finished attempt ${attempt}: ${status} (${safeErrorCode(error)})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Video transcript queue is temporarily unavailable (${safeErrorCode(error)}).`,
      );
    } finally {
      this.busy = false;
    }
  }
}
