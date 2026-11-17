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
import type { Prisma, StorageReplica } from "../../generated/prisma/client";
import { VideoStorage } from "./video-storage";
import { GcsReplicaStorage } from "./gcs-replica-storage";
import { objectKey, VideoError } from "./video-policy";
import {
  planLiveReplication,
  type LiveSnapshot,
} from "./live-replication-plan";

type Source = {
  storageLocationId: string;
  key?: string;
  size?: string;
  prefix?: string;
};
export const replicaPrefix = (kind: string, assetId: string) =>
  `replicas/${kind === "LIVE_DVR" ? "live" : "raw"}/${assetId}`;

@Injectable()
export class StorageReplicationWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private readonly running = new Map<string, Promise<void>>();
  private discovery?: Promise<void>;
  private readonly aborts = new Set<AbortController>();
  private stopping = false;
  private readonly logger = new Logger(StorageReplicationWorker.name);
  constructor(
    private readonly db: PrismaService,
    private readonly storage: VideoStorage,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}
  onApplicationBootstrap() {
    if (!this.config.video?.replication) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
    void this.tick();
  }
  async discover() {
    const bucket = this.config.video?.replication?.bucket;
    if (!bucket) return;
    // Anti-join before LIMIT prevents already-discovered files starving new work.
    const files = await this.db.$queryRaw<{ id: string }[]>`
      SELECT f.id FROM files f JOIN storage_locations l ON l.id = f.storage_location_id
      WHERE f.status = 'AVAILABLE' AND f.deleted_at IS NULL AND l.driver = 's3'
      AND NOT EXISTS (SELECT 1 FROM storage_replicas r WHERE r.kind = 'RAW'
        AND r.asset_id = f.id AND r.destination_bucket = ${bucket}) LIMIT 20`;
    for (const file of await this.db.libraryFile.findMany({
      where: { id: { in: files.map((f) => f.id) } },
    })) {
      await this.db.storageReplica.upsert({
        where: {
          kind_assetId_destinationBucket: {
            kind: "RAW",
            assetId: file.id,
            destinationBucket: bucket,
          },
        },
        create: {
          kind: "RAW",
          assetId: file.id,
          destinationBucket: bucket,
          source: {
            storageLocationId: file.storageLocationId!,
            key: file.objectKey,
            size: file.size.toString(),
          },
        },
        update: {},
      });
    }
    const recordings = await this.db.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM class_recordings c WHERE c.provider = 'IVS'
      AND c.status IN ('RECORDING','SAVING','SAVED') AND c.recording_prefix IS NOT NULL
      AND c.storage_location_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM storage_replicas r WHERE r.kind = 'LIVE_DVR'
        AND r.asset_id = c.id AND r.destination_bucket = ${bucket}) LIMIT 20`;
    for (const row of await this.db.classRecording.findMany({
      where: { id: { in: recordings.map((r) => r.id) } },
    })) {
      await this.db.storageReplica.upsert({
        where: {
          kind_assetId_destinationBucket: {
            kind: "LIVE_DVR",
            assetId: row.id,
            destinationBucket: bucket,
          },
        },
        create: {
          kind: "LIVE_DVR",
          assetId: row.id,
          destinationBucket: bucket,
          source: {
            storageLocationId: row.storageLocationId!,
            prefix: row.recordingPrefix!,
          },
        },
        update: {},
      });
    }
  }
  async tick() {
    if (!this.config.video?.replication || this.stopping) return;
    this.discovery ??= this.discover().finally(() => {
      this.discovery = undefined;
    });
    try {
      await this.discovery;
    } catch {
      this.logger.warn("STORAGE_REPLICATION_DISCOVERY_FAILED");
      return;
    }
    if (this.stopping) return;
    // Large raw uploads must not block the next DVR synchronization cycle.
    await Promise.all(
      ["RAW", "LIVE_DVR"].map((kind) => {
        const current = this.running.get(kind);
        if (current) return current;
        const work = this.runKind(kind)
          .catch(() => this.logger.warn("STORAGE_REPLICATION_TICK_FAILED"))
          .finally(() => {
            this.running.delete(kind);
          });
        this.running.set(kind, work);
        return work;
      }),
    );
  }
  private async runKind(kind: string) {
    const now = new Date();
    const row = await this.db.storageReplica.findFirst({
      where: {
        kind,
        destinationBucket: this.config.video!.replication!.bucket,
        completed: false,
        attempts: { lt: 8 },
        nextRunAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: { nextRunAt: "asc" },
    });
    if (!row) return;
    const owner = randomUUID();
    const claimed = await this.db.storageReplica.updateMany({
      where: {
        id: row.id,
        attempts: row.attempts,
        completed: false,
        nextRunAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        status: "COPYING",
        leaseOwner: owner,
        leaseUntil: new Date(Date.now() + 60000),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count) await this.replicate(row, owner);
  }
  private async valid(row: StorageReplica, source: Source) {
    if (row.kind === "RAW") {
      const file = await this.db.libraryFile.findUnique({
        where: { id: row.assetId },
      });
      return (
        !!file &&
        file.status === "AVAILABLE" &&
        !file.deletedAt &&
        file.storageLocationId === source.storageLocationId &&
        file.objectKey === source.key &&
        file.size.toString() === source.size
      );
    }
    const recording = await this.db.classRecording.findUnique({
      where: { id: row.assetId },
      include: { file: true },
    });
    return (
      !!recording &&
      ["RECORDING", "SAVING", "SAVED"].includes(recording.status) &&
      recording.storageLocationId === source.storageLocationId &&
      recording.recordingPrefix === source.prefix &&
      (!recording.file ||
        (recording.file.status === "AVAILABLE" && !recording.file.deletedAt))
    );
  }
  private async replicate(row: StorageReplica, owner: string) {
    const abort = new AbortController();
    this.aborts.add(abort);
    let client: S3Client | undefined,
      busy = false;
    const owned = () => ({
      id: row.id,
      leaseOwner: owner,
      leaseUntil: { gt: new Date() },
    });
    const heartbeat = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.db.storageReplica
        .updateMany({
          where: owned(),
          data: { leaseUntil: new Date(Date.now() + 60000) },
        })
        .then((r) => {
          if (!r.count) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          busy = false;
        });
    }, 15000);
    try {
      const source = row.source as Source;
      const assertLease = async () => {
        if (
          abort.signal.aborted ||
          !(await this.db.storageReplica.count({ where: owned() })) ||
          !(await this.valid(row, source))
        )
          throw new VideoError("LEASE_LOST");
      };
      await assertLease();
      const target = await this.storage.locations.resolve(
        source.storageLocationId,
      );
      if (target.driver !== "s3") throw new VideoError("SOURCE_NOT_READY");
      client = new S3Client({ region: target.region });
      const gcs = new GcsReplicaStorage(
        this.config.video?.replication?.projectId,
      );
      const destination = replicaPrefix(row.kind, row.assetId);
      let snapshot: Prisma.InputJsonValue,
        count = 1,
        readyThroughSeconds = 0,
        completed = true;
      if (row.kind === "RAW") {
        // File keys can contain names outside the HLS alphabet; the destination
        // is a fixed server-generated key, never interpreted as a local path.
        const key = source.key!;
        await gcs.copy(
          client,
          target.bucket,
          key,
          row.destinationBucket,
          row.id,
          abort.signal,
          destination + "/object",
          false,
          Number(source.size),
        );
        snapshot = { key: destination + "/object", size: source.size! };
      } else {
        objectKey(source.prefix);
        const keys = [
          ...(await this.storage.list(source.storageLocationId, source.prefix)),
        ];
        const manifests = keys.filter((k) => k.endsWith(".m3u8"));
        if (manifests.length > 64)
          throw new VideoError("REPLICA_LIMIT_EXCEEDED");
        const masters: string[] = [];
        for (const key of manifests) {
          if (
            (await this.storage.text(source.storageLocationId, key)).includes(
              "#EXT-X-STREAM-INF:",
            )
          )
            masters.push(key);
        }
        if (masters.length !== 1) throw new VideoError("SOURCE_NOT_READY");
        const plan = await planLiveReplication(
          source.prefix,
          masters[0],
          (key) => this.storage.text(source.storageLocationId, key),
        );
        if (plan.readyThroughSeconds < row.readyThroughSeconds)
          throw new VideoError("SOURCE_VERSION_CHANGED");
        if (row.snapshot) {
          const previous = row.snapshot as unknown as LiveSnapshot;
          if (
            previous.masterKey !== plan.masterKey ||
            Object.entries(previous.playlists).some(([key, text]) => {
              const before = text.replace(/#EXT-X-ENDLIST\s*$/, "").trimEnd();
              const after = plan.playlists[key]?.trimEnd();
              return (
                !after || !(after === before || after.startsWith(before + "\n"))
              );
            })
          )
            throw new VideoError("SOURCE_VERSION_CHANGED");
        }
        for (const key of plan.objects) {
          await assertLease();
          await gcs.copy(
            client,
            target.bucket,
            key,
            row.destinationBucket,
            row.id,
            abort.signal,
            destination + "/" + key.slice(source.prefix.length + 1),
            true,
          );
        }
        // Publish the entire manifest snapshot atomically in SQL after all media
        // is verified. Viewers never mix a newly copied child with an old master.
        snapshot = { ...plan, destinationPrefix: destination };
        count = plan.objects.length + Object.keys(plan.playlists).length;
        readyThroughSeconds = plan.readyThroughSeconds;
        completed = plan.ended;
      }
      await assertLease();
      await this.db.storageReplica.updateMany({
        where: owned(),
        data: {
          status: "READY",
          snapshot,
          objectCount: count,
          readyThroughSeconds,
          completed,
          lastSyncedAt: new Date(),
          errorCode: null,
          attempts: 0,
          nextRunAt: new Date(Date.now() + 5000),
          leaseOwner: null,
          leaseUntil: null,
        },
      });
    } catch (error) {
      const code = error instanceof VideoError ? error.code : "COPY_FAILED";
      await this.db.storageReplica.updateMany({
        where: { id: row.id, leaseOwner: owner },
        data: {
          // Keep a previously committed snapshot readable during a failed refresh.
          status: row.lastSyncedAt ? "READY" : "FAILED",
          errorCode: code,
          nextRunAt: new Date(
            Date.now() + Math.min(3600000, 5000 * 2 ** row.attempts),
          ),
          leaseOwner: null,
          leaseUntil: null,
        },
      });
      this.logger.warn(
        JSON.stringify({
          event: "storage_replication_failed",
          replicaId: row.id,
          code,
        }),
      );
    } finally {
      clearInterval(heartbeat);
      client?.destroy();
      this.aborts.delete(abort);
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const abort of this.aborts) abort.abort();
    await this.discovery?.catch(() => {});
    await Promise.all(this.running.values());
  }
}
