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
    this.running = this.process().catch(() => {
      console.warn(JSON.stringify({ event: "file_cleanup_unavailable" }));
    });
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async process() {
    for (let count = 0; count < 20; count++) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const jobs = await tx.$queryRaw<
          Array<{ file_id: string; object_key: string; attempts: number }>
        >`
          SELECT file_id, object_key, attempts FROM file_object_deletions
          WHERE completed_at IS NULL AND next_attempt_at <= now()
          ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`;
        if (!jobs[0]) return null;
        const job = jobs[0];
        // Durable lease allows another instance to retry after a crash.
        await tx.$executeRaw`UPDATE file_object_deletions
          SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
          WHERE file_id = ${job.file_id}::uuid`;
        return job;
      });
      if (!claimed) break;
      try {
        await this.storage.delete(claimed.object_key);
        await this.prisma.fileObjectDeletion.update({
          where: { fileId: claimed.file_id },
          data: { completedAt: new Date() },
        });
      } catch {
        const delayMs = Math.min(
          3600000,
          30000 * 2 ** Math.min(claimed.attempts, 7),
        );
        await this.prisma.$executeRaw`UPDATE file_object_deletions
          SET next_attempt_at = now() + ${delayMs} * interval '1 millisecond'
          WHERE file_id = ${claimed.file_id}::uuid`;
        console.warn(
          JSON.stringify({
            event: "file_cleanup_retry",
            fileId: claimed.file_id,
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
