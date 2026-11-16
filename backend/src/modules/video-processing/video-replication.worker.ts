import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import type { Prisma, VideoReplica } from "../../generated/prisma/client";
import { VideoStorage } from "./video-storage";
import { VideoError, type VideoOutput } from "./video-policy";
import { planVodReplication } from "./replication-plan";
import { GcsReplicaStorage } from "./gcs-replica-storage";

@Injectable()
export class VideoReplicationWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private abort?: AbortController;
  private readonly logger = new Logger(VideoReplicationWorker.name);
  constructor(
    private readonly db: PrismaService,
    private readonly source: VideoStorage,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}
  onApplicationBootstrap() {
    if (!this.config.video?.replication) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 15000);
    this.timer.unref();
    void this.tick();
  }
  async discover() {
    const bucket = this.config.video?.replication?.bucket;
    if (!bucket) return;
    const assets = await this.db.videoAsset.findMany({
      where: {
        file: { status: "AVAILABLE", deletedAt: null },
        publishedJob: {
          state: "READY",
          encoder: { in: ["mediaconvert", "ivs"] },
          replicas: { none: { destinationBucket: bucket } },
        },
      },
      include: { publishedJob: true },
      take: 20,
    });
    for (const asset of assets) {
      const job = asset.publishedJob;
      if (!job?.output) continue;
      await this.db.videoReplica.upsert({
        where: {
          jobId_destinationBucket: { jobId: job.id, destinationBucket: bucket },
        },
        create: {
          fileId: asset.fileId,
          jobId: job.id,
          destinationBucket: bucket,
          output: job.output as Prisma.InputJsonValue,
        },
        update: {},
      });
    }
  }
  async tick() {
    if (!this.config.video?.replication || this.running) return this.running;
    this.running = (async () => {
      await this.discover();
      const now = new Date();
      const candidate = await this.db.videoReplica.findFirst({
        where: {
          destinationBucket: this.config.video!.replication!.bucket,
          status: { in: ["PENDING", "COPYING", "FAILED"] },
          attempts: { lt: 8 },
          nextRunAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          file: { status: "AVAILABLE", deletedAt: null },
        },
        orderBy: { nextRunAt: "asc" },
      });
      if (!candidate) return;
      const owner = randomUUID();
      const claimed = await this.db.videoReplica.updateMany({
        where: {
          id: candidate.id,
          attempts: candidate.attempts,
          status: { in: ["PENDING", "COPYING", "FAILED"] },
          nextRunAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        },
        data: {
          status: "COPYING",
          leaseOwner: owner,
          leaseUntil: new Date(Date.now() + 60000),
          attempts: { increment: 1 },
          errorCode: null,
        },
      });
      if (claimed.count) await this.replicate(candidate, owner);
    })().catch(() => this.logger.warn("VIDEO_REPLICATION_TICK_FAILED"));
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async replicate(replica: VideoReplica, owner: string) {
    const abort = new AbortController();
    this.abort = abort;
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.db.videoReplica
        .updateMany({
          where: {
            id: replica.id,
            leaseOwner: owner,
            leaseUntil: { gt: new Date() },
          },
          data: { leaseUntil: new Date(Date.now() + 60000) },
        })
        .then((result) => {
          if (!result.count) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 15000);
    const assertLease = async () => {
      if (
        abort.signal.aborted ||
        !(await this.db.videoReplica.count({
          where: {
            id: replica.id,
            leaseOwner: owner,
            leaseUntil: { gt: new Date() },
            file: { status: "AVAILABLE", deletedAt: null },
          },
        }))
      )
        throw new VideoError("LEASE_LOST");
    };
    let client: S3Client | undefined;
    try {
      const output = replica.output as unknown as VideoOutput;
      const target = await this.source.locations.resolve(
        output.storageLocationId,
      );
      if (target.driver !== "s3") throw new VideoError("SOURCE_NOT_READY");
      const plan = await planVodReplication(output, (key) =>
        this.source.text(output.storageLocationId, key),
      );
      client = new S3Client({ region: target.region });
      const destination = new GcsReplicaStorage(
        this.config.video?.replication?.projectId,
      );
      for (const key of plan.objects) {
        await assertLease();
        await destination.copy(
          client,
          target.bucket,
          key,
          replica.destinationBucket,
          replica.jobId,
          abort.signal,
        );
      }
      for (const playlist of plan.playlists) {
        await assertLease();
        // Reject a source mutation instead of publishing a mixed playlist snapshot.
        if (
          (await this.source.text(output.storageLocationId, playlist.key)) !==
          playlist.text
        )
          throw new VideoError("SOURCE_VERSION_CHANGED");
        await destination.playlist(
          replica.destinationBucket,
          playlist.key,
          playlist.text,
          replica.jobId,
        );
      }
      await assertLease();
      await this.db.videoReplica.updateMany({
        where: {
          id: replica.id,
          leaseOwner: owner,
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: "READY",
          lastSyncedAt: new Date(),
          objectCount: plan.objects.length + plan.playlists.length,
          leaseOwner: null,
          leaseUntil: null,
          errorCode: null,
        },
      });
    } catch (error) {
      const code = error instanceof VideoError ? error.code : "COPY_FAILED";
      await this.db.videoReplica.updateMany({
        where: { id: replica.id, leaseOwner: owner },
        data: {
          status: "FAILED",
          errorCode: code,
          nextRunAt: new Date(
            Date.now() + Math.min(3600000, 15000 * 2 ** replica.attempts),
          ),
          leaseOwner: null,
          leaseUntil: null,
        },
      });
      this.logger.warn(
        JSON.stringify({
          event: "video_replication_failed",
          replicaId: replica.id,
          code,
        }),
      );
    } finally {
      clearInterval(heartbeat);
      client?.destroy();
      this.abort = undefined;
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.abort?.abort();
    await this.running;
  }
}
