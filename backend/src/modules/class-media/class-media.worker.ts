import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import { ApiError } from "../../common/api-error";
import { ClassMediaService } from "./class-media.service";

@Injectable()
export class ClassMediaWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private warningAt = 0;
  private readonly logger = new Logger(ClassMediaWorker.name);
  constructor(
    private readonly db: PrismaService,
    private readonly media: ClassMediaService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}
  onApplicationBootstrap() {
    if (!this.config.ivs?.enabled) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }
  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const rows = await this.db.classMediaConnection.findMany({
        where: {
          state: { in: ["ACTIVE", "REVOKING", "ISSUING"] },
          checkedAt: { lte: new Date() },
        },
        orderBy: { checkedAt: "asc" },
        take: 5,
        include: { room: true },
      });
      for (const row of rows) {
        if (this.stopping) break;
        if (!row.room.stageArn) continue;
        const claimed = await this.db.classMediaConnection.updateMany({
          where: { id: row.id, checkedAt: row.checkedAt },
          data: { checkedAt: new Date(Date.now() + 20000) },
        });
        if (!claimed.count) continue;
        try {
          const stale = row.lastSeenAt.getTime() < Date.now() - 30000;
          if (
            row.state === "ISSUING" &&
            row.leaseUntil &&
            row.leaseUntil > new Date()
          )
            continue;
          if (row.state === "REVOKING" || stale || row.state === "ISSUING")
            await this.media.revoke(row, row.room.stageArn);
          else {
            try {
              await this.media.require(
                { userId: row.userId, authSessionId: row.authSessionId },
                row.sessionId,
                row.participationId,
              );
            } catch (error) {
              if (
                !(error instanceof ApiError) ||
                ![400, 401, 403, 404, 409].includes(error.getStatus())
              )
                throw error;
              await this.media.revoke(row, row.room.stageArn);
            }
          }
        } catch {
          this.warn();
        } finally {
          await this.db.classMediaConnection.update({
            where: { id: row.id },
            data: { checkedAt: new Date() },
          });
        }
      }
      // One room per second caps the control-plane polling rate across this worker.
      const room = await this.db.classMediaRoom.findFirst({
        where: {
          stageArn: { not: null },
          state: { in: ["READY", "CLOSING"] },
          checkedAt: { lt: new Date(Date.now() - 10000) },
        },
        orderBy: { checkedAt: "asc" },
        include: { session: true },
      });
      if (room?.stageArn) {
        const claimed = await this.db.classMediaRoom.updateMany({
          where: { sessionId: room.sessionId, checkedAt: room.checkedAt },
          data: { checkedAt: new Date(Date.now() + 120000) },
        });
        if (!claimed.count) return;
        if (room.session.status !== "LIVE") {
          await this.db.classMediaRoom.update({
            where: { sessionId: room.sessionId },
            data: { state: "CLOSING" },
          });
          const pending = await this.db.classMediaConnection.count({
            where: { sessionId: room.sessionId, state: { not: "REVOKED" } },
          });
          // T11 must finish compositions before Stage deletion.
          if (!pending && (await this.media.ivs.close(room.stageArn)))
            await this.db.classMediaRoom.update({
              where: { sessionId: room.sessionId },
              data: { state: "CLOSED" },
            });
        } else {
          const snapshot = await this.media.ivs.presence(room.stageArn);
          await this.db.$transaction(async (tx) => {
            await tx.classMediaRoom.update({
              where: { sessionId: room.sessionId },
              data: { stageSessionId: snapshot.sessionId },
            });
            await tx.classMediaConnection.updateMany({
              where: { sessionId: room.sessionId },
              data: { connected: false },
            });
            await tx.classMediaConnection.updateMany({
              where: {
                sessionId: room.sessionId,
                state: "ACTIVE",
                participantId: { in: [...snapshot.connectedIds] },
              },
              data: { connected: true },
            });
          });
        }
        await this.db.classMediaRoom.update({
          where: { sessionId: room.sessionId },
          data: { checkedAt: new Date() },
        });
      }
    } catch {
      this.warn();
    } finally {
      this.busy = false;
    }
  }
  private warn() {
    if (Date.now() - this.warningAt > 60000) {
      this.warningAt = Date.now();
      this.logger.warn(
        "IVS đang chờ đồng bộ lại; kiểm tra quyền AWS, database và mạng.",
      );
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
