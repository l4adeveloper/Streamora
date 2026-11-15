import { EventEmitter } from "node:events";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Prisma, VideoJob } from "../../generated/prisma/client";
import type { VideoConfig } from "./video-config";
import {
  ACTIVE,
  type CloudVideoAsset,
  type VideoJobStore,
} from "./video-job-store";
import {
  readSource,
  VideoError,
  type SourceMetadata,
  type VideoOutput,
  type VideoSource,
  type VideoPolicy,
} from "./video-policy";
import { locationId, type StorageTarget } from "../files/storage-target";

const key = (pk: string) => ({ pk, sk: "DATA" });
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const terminal = (state: string) => ["READY", "FAILED"].includes(state);
function conditional(error: unknown) {
  const e = error as {
    name?: string;
    CancellationReasons?: { Code?: string }[];
  };
  return (
    e.name === "ConditionalCheckFailedException" ||
    (e.name === "TransactionCanceledException" &&
      e.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed"))
  );
}
function decode(item: Record<string, any>): VideoJob {
  const job = { ...item };
  for (const field of [
    "createdAt",
    "updatedAt",
    "nextRunAt",
    "submittedAt",
    "leaseUntil",
    "lastDispatchAt",
  ])
    if (job[field] !== null && job[field] !== undefined)
      job[field] = new Date(job[field]);
  return job as VideoJob;
}
function reference(source: VideoSource) {
  if (source.kind !== "HLS") return;
  const parts = source.prefix.split("/");
  // Only our generated output trees are candidates for automatic deletion.
  if (parts[0] === "groups" && parts[2] === "videos" && parts.length >= 5)
    return `REF#${source.storageLocationId}#${parts.slice(0, 5).join("/")}`;
}

// DynamoDB is the authoritative AWS job store. No SQL client, DB URL or VPC is used.
export class DynamoVideoJobs extends EventEmitter implements VideoJobStore {
  readonly config: { video: VideoConfig };
  readonly client: DynamoDBDocumentClient;
  private readonly locations = new Map<string, StorageTarget>();
  constructor(
    video: VideoConfig,
    readonly sourceBucket: string,
    client?: DynamoDBDocumentClient,
  ) {
    super();
    this.config = { video };
    this.client =
      client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region: video.region,
          maxAttempts: 3,
          requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
        }),
        { marshallOptions: { removeUndefinedValues: true } },
      );
  }
  get table() {
    return this.config.video.tableName;
  }
  private async get(pk: string) {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: key(pk),
          ConsistentRead: true,
        }),
      )
    ).Item;
  }
  async job(id: string) {
    const item = await this.get(`JOB#${id}`);
    return item ? decode(item) : null;
  }
  async asset(fileId: string) {
    return (await this.get(`FILE#${fileId}`)) as CloudVideoAsset | undefined;
  }
  async state(fileId: string) {
    const asset = await this.asset(fileId);
    const sameJob = asset?.publishedJobId === asset?.currentJobId;
    const [job, previous] = await Promise.all([
      asset ? this.job(asset.currentJobId) : null,
      !sameJob && asset?.publishedJobId ? this.job(asset.publishedJobId) : null,
    ]);
    return { asset, job, published: sameJob ? job : previous };
  }
  async putLocation(target: StorageTarget) {
    if (
      target.driver !== "s3" ||
      target.region !== this.config.video.region ||
      ![this.sourceBucket, this.config.video.outputBucket].includes(
        target.bucket,
      )
    )
      throw new VideoError("VIDEO_SOURCE_NOT_CLOUD");
    const id = locationId(target);
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...key(`LOCATION#${id}`), kind: "LOCATION", target },
      }),
    );
    this.locations.set(id, target);
    return id;
  }
  async resolve(id?: string | null): Promise<StorageTarget> {
    if (!id) throw new VideoError("SOURCE_MISSING");
    const cached = this.locations.get(id);
    if (cached) return cached;
    const target = (await this.get(`LOCATION#${id}`))?.target as
      StorageTarget | undefined;
    if (
      !target ||
      locationId(target) !== id ||
      target.driver !== "s3" ||
      target.region !== this.config.video.region ||
      ![this.sourceBucket, this.config.video.outputBucket].includes(
        target.bucket,
      )
    )
      throw new VideoError("SOURCE_MISSING");
    this.locations.set(id, target);
    return target;
  }
  async outputLocation() {
    const target: StorageTarget = {
      driver: "s3",
      bucket: this.config.video.outputBucket,
      region: this.config.video.region,
    };
    const id = locationId(target);
    return this.locations.has(id) ? id : this.putLocation(target);
  }
  async ensure(
    job: VideoJob,
    file: { id: string; groupId: string },
    sourceValue: unknown,
    sourceTarget: StorageTarget,
    published?: VideoJob | null,
  ) {
    const source = readSource(sourceValue);
    if (
      file.id !== job.fileId ||
      job.encoder === "ffmpeg" ||
      source.storageLocationId !== locationId(sourceTarget)
    )
      throw new VideoError("VIDEO_SOURCE_NOT_CLOUD");
    await this.putLocation(sourceTarget);
    await this.outputLocation();
    if (await this.job(job.id)) return;
    const previous = await this.asset(job.fileId);
    const items: any[] = [];
    if (previous && previous.currentJobId !== job.id) {
      items.push({
        ConditionCheck: {
          TableName: this.table,
          Key: key(`JOB#${previous.currentJobId}`),
          ConditionExpression: "#s=:failed",
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: { ":failed": "FAILED" },
        },
      });
    }
    const document = (row: VideoJob) => ({
      ...clean(row),
      ...key(`JOB#${row.id}`),
      kind: "JOB",
      file,
      source,
      leaseOwner: null,
      leaseUntil: null,
      nextRunAt: new Date().toISOString(),
      work: terminal(row.state) ? "RETIRED" : "ACTIVE",
      dueAt: Date.now() + (terminal(row.state) ? 7 * 86400000 : 0),
    });
    items.push({
      Put: {
        TableName: this.table,
        Item: document(job),
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
    if (published && published.id !== job.id && !(await this.job(published.id)))
      items.push({
        Put: {
          TableName: this.table,
          Item: document(published),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
    const values: Record<string, any> = {
      ":id": job.id,
      ":source": source,
      ":fileId": job.fileId,
      ":kind": "ASSET",
      ":no": false,
    };
    let update =
      "SET currentJobId=:id, #source=:source, fileId=:fileId, kind=:kind, deleted=:no";
    if (published) {
      values[":published"] = published.id;
      update += ", publishedJobId=if_not_exists(publishedJobId,:published)";
    }
    if (previous) values[":previous"] = previous.currentJobId;
    items.push({
      Update: {
        TableName: this.table,
        Key: key(`FILE#${job.fileId}`),
        UpdateExpression: update,
        ConditionExpression: previous
          ? "currentJobId=:previous AND deleted=:no"
          : "attribute_not_exists(currentJobId)",
        ExpressionAttributeNames: { "#source": "source" },
        ExpressionAttributeValues: values,
      },
    });
    const ref = reference(source);
    if (ref) {
      items.push({
        ConditionCheck: {
          TableName: this.table,
          Key: key(
            `JOB#${source.kind === "HLS" ? source.prefix.split("/")[4] : ""}`,
          ),
          ConditionExpression: "attribute_not_exists(cleanupStarted)",
        },
      });
      items.push({
        Put: {
          TableName: this.table,
          Item: { pk: ref, sk: job.fileId, kind: "REFERENCE" },
        },
      });
    }
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: items }),
      );
    } catch (error) {
      if (!conditional(error) || !(await this.job(job.id))) throw error;
    }
  }
  async due(limit = 8, work = "ACTIVE") {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "work-due",
        KeyConditionExpression: "#work=:work AND dueAt<=:now",
        ExpressionAttributeNames: { "#work": "work" },
        ExpressionAttributeValues: { ":work": work, ":now": Date.now() },
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map(decode);
  }
  async claim(owner: string, id?: string) {
    const job = id ? await this.job(id) : (await this.due(1))[0];
    if (!job || !ACTIVE.includes(job.state)) return null;
    const resume = job.encoder === "mediaconvert" && job.state !== "QUEUED";
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: key(`JOB#${job.id}`),
          ConditionExpression:
            "#s=:expected AND attemptNo=:attempt AND dueAt<=:now AND (attribute_not_exists(leaseUntil) OR leaseUntil=:nil OR leaseUntil<:now)",
          UpdateExpression:
            "SET leaseOwner=:owner, leaseUntil=:lease, #s=:state, attemptNo=:next, updatedAt=:updated ADD deliveryCount :one",
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: {
            ":expected": job.state,
            ":attempt": job.attemptNo,
            ":now": Date.now(),
            ":nil": null,
            ":owner": owner,
            ":lease": Date.now() + 30000,
            ":state": resume ? job.state : "PROCESSING",
            ":next": resume ? job.attemptNo : job.attemptNo + 1,
            ":updated": new Date().toISOString(),
            ":one": 1,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return decode(result.Attributes!);
    } catch (error) {
      if (conditional(error)) return null;
      throw error;
    }
  }
  async load(job: VideoJob) {
    const [row, asset] = await Promise.all([
      this.get(`JOB#${job.id}`),
      this.asset(job.fileId),
    ]);
    if (!row || !asset || asset.deleted || asset.currentJobId !== job.id)
      throw new VideoError("SOURCE_MISSING");
    return {
      file: { ...row.file, status: "AVAILABLE" },
      asset: { source: row.source },
    };
  }
  private fenced(job: VideoJob) {
    return {
      ConditionExpression:
        "leaseOwner=:owner AND attemptNo=:attempt AND leaseUntil>:now AND #s IN (:q,:s,:p,:v)",
      ExpressionAttributeNames: { "#s": "state" } as Record<string, string>,
      ExpressionAttributeValues: {
        ":owner": job.leaseOwner,
        ":attempt": job.attemptNo,
        ":now": Date.now(),
        ":q": "QUEUED",
        ":s": "SUBMITTING",
        ":p": "PROCESSING",
        ":v": "VERIFYING",
      } as Record<string, any>,
    };
  }
  async update(job: VideoJob, patch: Prisma.VideoJobUpdateManyMutationInput) {
    const fence = this.fenced(job),
      sets = ["updatedAt=:updated"],
      adds: string[] = [];
    fence.ExpressionAttributeValues[":updated"] = new Date().toISOString();
    for (const [field, original] of Object.entries(patch)) {
      if (original === undefined) continue;
      const name = `#f${sets.length + adds.length}`,
        value = `:f${sets.length + adds.length}`;
      fence.ExpressionAttributeNames[name] = field;
      const increment =
        original && typeof original === "object" && "increment" in original;
      if (increment) {
        adds.push(`${name} ${value}`);
        fence.ExpressionAttributeValues[value] = original.increment;
      } else {
        sets.push(`${name}=${value}`);
        fence.ExpressionAttributeValues[value] =
          field === "leaseUntil" && original instanceof Date
            ? original.getTime()
            : clean(original);
      }
      if (field === "nextRunAt") {
        sets.push("dueAt=:due");
        fence.ExpressionAttributeValues[":due"] = new Date(
          original as Date,
        ).getTime();
      }
    }
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: key(`JOB#${job.id}`),
          ...fence,
          UpdateExpression:
            "SET " +
            sets.join(", ") +
            (adds.length ? " ADD " + adds.join(", ") : ""),
        }),
      );
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw error;
    }
  }
  async saveMetadata(job: VideoJob, metadata: SourceMetadata) {
    if (!(await this.update(job, { sourceMetadata: metadata } as any)))
      throw new VideoError("LEASE_LOST");
  }
  heartbeat(job: VideoJob, progressPercent?: number) {
    return this.update(job, {
      leaseUntil: new Date(Date.now() + 30000),
      ...(progressPercent !== undefined ? { progressPercent } : {}),
    });
  }
  private async finish(
    job: VideoJob,
    state: "READY" | "FAILED",
    output?: VideoOutput,
    code?: string,
  ) {
    const fence = this.fenced(job);
    Object.assign(fence.ExpressionAttributeValues, {
      ":terminal": state,
      ":updated": new Date().toISOString(),
      ":retired": "RETIRED",
      ":due": Date.now() + 7 * 86400000,
      ":nil": null,
      ":progress": state === "READY" ? 100 : job.progressPercent,
      ":error": code ?? null,
    });
    let update =
      "SET #s=:terminal, updatedAt=:updated, #work=:retired, dueAt=:due, leaseOwner=:nil, leaseUntil=:nil, progressPercent=:progress, errorCode=:error";
    fence.ExpressionAttributeNames["#work"] = "work";
    if (output) {
      update += ", #output=:output";
      fence.ExpressionAttributeNames["#output"] = "output";
      fence.ExpressionAttributeValues[":output"] = output;
    }
    const items: any[] = [
      {
        Update: {
          TableName: this.table,
          Key: key(`JOB#${job.id}`),
          ...fence,
          UpdateExpression: update,
        },
      },
    ];
    items.push(
      output
        ? {
            Update: {
              TableName: this.table,
              Key: key(`FILE#${job.fileId}`),
              ConditionExpression: "currentJobId=:job AND deleted=:no",
              UpdateExpression: "SET publishedJobId=:job",
              ExpressionAttributeValues: { ":job": job.id, ":no": false },
            },
          }
        : {
            ConditionCheck: {
              TableName: this.table,
              Key: key(`FILE#${job.fileId}`),
              ConditionExpression: "currentJobId=:job",
              ExpressionAttributeValues: { ":job": job.id },
            },
          },
    );
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: items }),
      );
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw error;
    }
  }
  publish(job: VideoJob, output: VideoOutput) {
    return this.finish(job, "READY", output);
  }
  async fail(job: VideoJob, code: string) {
    if (!(await this.finish(job, "FAILED", undefined, code)))
      throw new VideoError("LEASE_LOST");
  }
  async expedite(id: string, attempt: number, providerId?: string) {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: key(`JOB#${id}`),
          ConditionExpression:
            "attemptNo=:attempt AND #s IN (:s,:p,:v)" +
            (providerId
              ? " AND (providerJobId=:provider OR attribute_not_exists(providerJobId) OR providerJobId=:nil)"
              : ""),
          UpdateExpression:
            "SET dueAt=:now, nextRunAt=:date" +
            (providerId ? ", providerJobId=:provider" : ""),
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: {
            ":attempt": attempt,
            ":s": "SUBMITTING",
            ":p": "PROCESSING",
            ":v": "VERIFYING",
            ":now": Date.now(),
            ":date": new Date().toISOString(),
            ...(providerId ? { ":provider": providerId, ":nil": null } : {}),
          },
        }),
      );
    } catch (error) {
      if (!conditional(error)) throw error;
    }
  }
  async deleted(fileId: string) {
    const asset = await this.asset(fileId);
    if (!asset || asset.deleted) return;
    const job = await this.job(asset.currentJobId);
    if (!job || !terminal(job.state))
      throw new VideoError("VIDEO_DISPATCH_PENDING");
    const items: any[] = [
      {
        Update: {
          TableName: this.table,
          Key: key(`FILE#${fileId}`),
          ConditionExpression: "currentJobId=:id",
          UpdateExpression: "SET deleted=:yes",
          ExpressionAttributeValues: { ":id": job.id, ":yes": true },
        },
      },
    ];
    const ref = reference(asset.source);
    if (ref)
      items.push({
        Delete: { TableName: this.table, Key: { pk: ref, sk: fileId } },
      });
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
  }
  async cleanup(
    remove: (location: string, prefix: string) => Promise<void>,
    remaining: () => number,
  ) {
    for (const job of await this.due(10, "RETIRED")) {
      if (remaining() < 45000) break;
      const row = await this.get(`JOB#${job.id}`),
        asset = await this.asset(job.fileId);
      if (!row || !terminal(row.state)) continue;
      if (
        row.mode === "TRANSCODE" &&
        !(asset?.publishedJobId === job.id && !asset.deleted)
      ) {
        // Fence future HLS imports before checking references and deleting objects.
        // Import transactions check this marker, closing the check/delete race.
        try {
          await this.client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: this.table,
                    Key: key(`JOB#${job.id}`),
                    UpdateExpression: "SET cleanupStarted=:yes",
                    ConditionExpression: "#s IN (:ready,:failed)",
                    ExpressionAttributeNames: { "#s": "state" },
                    ExpressionAttributeValues: {
                      ":yes": true,
                      ":ready": "READY",
                      ":failed": "FAILED",
                    },
                  },
                },
                {
                  ConditionCheck: {
                    TableName: this.table,
                    Key: key(`FILE#${job.fileId}`),
                    ConditionExpression:
                      "attribute_not_exists(publishedJobId) OR publishedJobId<>:id OR deleted=:yes",
                    ExpressionAttributeValues: { ":id": job.id, ":yes": true },
                  },
                },
              ],
            }),
          );
        } catch (error) {
          if (conditional(error)) continue;
          throw error;
        }
        const root = `groups/${row.file.groupId}/videos/${job.fileId}/${job.id}`;
        const location =
          (job.output as unknown as VideoOutput)?.storageLocationId ??
          (job.policy as unknown as VideoPolicy)?.outputLocationId;
        const refs = location
          ? await this.client.send(
              new QueryCommand({
                TableName: this.table,
                KeyConditionExpression: "pk=:pk",
                ExpressionAttributeValues: { ":pk": `REF#${location}#${root}` },
                Limit: 1,
                ConsistentRead: true,
              }),
            )
          : undefined;
        if (!refs?.Items?.length) {
          if (location) await remove(location, root);
          await this.client.send(
            new UpdateCommand({
              TableName: this.table,
              Key: key(`JOB#${job.id}`),
              UpdateExpression: "SET cleanedAt=:now REMOVE #work,dueAt",
              ExpressionAttributeNames: { "#work": "work" },
              ExpressionAttributeValues: { ":now": new Date().toISOString() },
            }),
          );
          continue;
        }
      }
      if (row.mode === "IMPORT_HLS") {
        await this.client.send(
          new UpdateCommand({
            TableName: this.table,
            Key: key(`JOB#${job.id}`),
            UpdateExpression: "REMOVE #work,dueAt",
            ExpressionAttributeNames: { "#work": "work" },
          }),
        );
      } else {
        // Keep published/reference trees and revisit after a future retry/deletion.
        await this.client.send(
          new UpdateCommand({
            TableName: this.table,
            Key: key(`JOB#${job.id}`),
            UpdateExpression: "SET dueAt=:due",
            ExpressionAttributeValues: { ":due": Date.now() + 7 * 86400000 },
          }),
        );
      }
    }
  }
  close() {
    this.client.destroy();
  }
}
