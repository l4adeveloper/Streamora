import type { EventEmitter } from "node:events";
import type { Prisma, VideoJob } from "../../generated/prisma/client";
import type { PrismaService } from "../../database/prisma.service";
import type { EnvironmentConfig } from "../../config/environment";
import type { SourceMetadata, VideoOutput, VideoSource } from "./video-policy";

export const ACTIVE = ["QUEUED", "SUBMITTING", "PROCESSING", "VERIFYING"];

export interface VideoJobStore extends EventEmitter {
  readonly config: Pick<EnvironmentConfig, "video">;
  // Present only in the local adapter, for local retention.
  readonly db?: PrismaService;
  claim(owner: string, id?: string): Promise<VideoJob | null>;
  load(job: VideoJob): Promise<{
    file: {
      id: string;
      groupId: string;
      status: string;
      deletedAt?: Date | null;
    };
    asset: { source: unknown };
  }>;
  saveMetadata(job: VideoJob, metadata: SourceMetadata): Promise<unknown>;
  update(
    job: VideoJob,
    data: Prisma.VideoJobUpdateManyMutationInput,
  ): Promise<boolean>;
  heartbeat(job: VideoJob, progressPercent?: number): Promise<boolean>;
  publish(job: VideoJob, output: VideoOutput): Promise<boolean>;
  fail(job: VideoJob, code: string): Promise<void>;
  outputLocation(): Promise<string>;
  cleanup?(
    remove: (location: string, prefix: string) => Promise<void>,
    remaining: () => number,
  ): Promise<void>;
}

export interface CloudVideoAsset {
  fileId: string;
  currentJobId: string;
  publishedJobId?: string;
  source: VideoSource;
  deleted?: boolean;
}
