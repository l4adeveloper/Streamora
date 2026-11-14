import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { validClassLease } from "../../database/class-presence";
import { ClassSessionsService } from "./class-sessions.service";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";

@Injectable()
export class ClassSessionAutoCloseService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ClassSessionAutoCloseService.name);
  private readonly emptySince = new Map<string, number>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private emptyTimeoutMs = 60_000; // 1 minute (60 seconds)
  private leaseTtlMs = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: ClassSessionsService,
    @Optional() @Inject(APP_CONFIG) config?: EnvironmentConfig,
  ) {
    if (config?.sessionRealtime?.leaseTtlMs) {
      this.leaseTtlMs = config.sessionRealtime.leaseTtlMs;
    }
  }

  setEmptyTimeoutMs(ms: number) {
    this.emptyTimeoutMs = ms;
  }

  getEmptyTimeoutMs(): number {
    return this.emptyTimeoutMs;
  }

  getEmptySince(sessionId: string): number | undefined {
    return this.emptySince.get(sessionId);
  }

  onApplicationBootstrap() {
    this.sweepTimer = setInterval(() => void this.sweep(), 2000);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    this.stopping = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    this.emptySince.clear();
  }

  async countActiveParticipants(
    sessionId: string,
    now: Date = new Date(),
  ): Promise<number> {
    return this.prisma.classParticipation.count({
      where: {
        sessionId,
        leftAt: null,
        AND: [
          {
            OR: [
              {
                lastSeenAt: {
                  gt: new Date(now.getTime() - this.leaseTtlMs),
                },
              },
              { leases: { some: validClassLease(now) } },
            ],
          },
          {
            OR: [
              { joinRequestId: null },
              { joinRequest: { status: "ACCEPTED" } },
            ],
          },
        ],
      },
    });
  }

  async checkSession(
    sessionId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true },
    });

    if (!session || session.status !== "LIVE") {
      this.emptySince.delete(sessionId);
      return false;
    }

    const activeCount = await this.countActiveParticipants(sessionId, now);
    if (activeCount === 0) {
      if (!this.emptySince.has(sessionId)) {
        this.emptySince.set(sessionId, now.getTime());
        this.logger.log(
          `Phòng họp ${sessionId} không còn thành viên nào. Bắt đầu đếm ngược ${this.emptyTimeoutMs / 1000}s để tự động đóng phòng.`,
        );
      } else {
        const elapsed = now.getTime() - this.emptySince.get(sessionId)!;
        if (elapsed >= this.emptyTimeoutMs) {
          this.logger.log(
            `Phòng họp ${sessionId} đã trống trong ${elapsed}ms (>= ${this.emptyTimeoutMs}ms). Tự động đóng phòng.`,
          );
          this.emptySince.delete(sessionId);
          await this.sessions.endSessionBySystem(sessionId);
          return true;
        }
      }
    } else {
      if (this.emptySince.has(sessionId)) {
        this.emptySince.delete(sessionId);
        this.logger.log(
          `Phòng họp ${sessionId} có thành viên tham gia lại (${activeCount} người). Hủy đếm ngược tự động đóng phòng.`,
        );
      }
    }
    return false;
  }

  async sweep(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const liveSessions = await this.prisma.classSession.findMany({
        where: { status: "LIVE" },
        select: { id: true },
      });

      const liveIds = new Set(liveSessions.map((s) => s.id));
      for (const id of this.emptySince.keys()) {
        if (!liveIds.has(id)) {
          this.emptySince.delete(id);
        }
      }

      const now = new Date();
      for (const session of liveSessions) {
        await this.checkSession(session.id, now);
      }
    } catch (error) {
      this.logger.error("Lỗi khi kiểm tra phòng họp trống để tự động đóng:", error);
    } finally {
      this.busy = false;
    }
  }
}
