import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import { FileStorageService } from "./file-storage.service";
import { safeErrorCode } from "../../common/safe-error-code";

@Injectable()
export class FileCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}
  onModuleInit() {
    if (
      !this.config.files?.cleanupEnabled ||
      (this.config.files.driver !== "local" && !this.config.files.bucket)
    )
      return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 30000);
    this.timer.unref();
  }
  async tick() {
    if (this.running) return this.running;
    this.running = this.process().catch((error) => {
      console.warn(
        JSON.stringify({
          event: "file_cleanup_unavailable",
          code: safeErrorCode(error),
        }),
      );
    });
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async process() {
    for (let count = 0; count < 20; count++) {
      // Atomic claim in one round trip; no interactive transaction/pool connection held for storage I/O.
      const jobs = await this.prisma.$queryRaw<
        Array<{
          file_id: string;
          object_key: string;
          storage_location_id: string | null;
          attempts: number;
        }>
      >`UPDATE file_object_deletions SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
        WHERE file_id = (SELECT file_id FROM file_object_deletions
          WHERE completed_at IS NULL AND next_attempt_at <= now()
          ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING file_id, object_key, storage_location_id, attempts`;
      const claimed = jobs[0];
      if (!claimed) break;
      try {
        await this.storage.delete(
          claimed.object_key,
          claimed.storage_location_id,
        );
        await this.prisma.fileObjectDeletion.update({
          where: { fileId: claimed.file_id },
          data: { completedAt: new Date() },
        });
      } catch (error) {
        const delayMs = Math.min(
          3600000,
          30000 * 2 ** Math.min(claimed.attempts - 1, 7),
        );
        await this.prisma.$executeRaw`UPDATE file_object_deletions
          SET next_attempt_at = now() + ${delayMs} * interval '1 millisecond'
          WHERE file_id = ${claimed.file_id}::uuid`;
        console.warn(
          JSON.stringify({
            event: "file_cleanup_retry",
            fileId: claimed.file_id,
            code: safeErrorCode(error),
          }),
        );
      }
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
