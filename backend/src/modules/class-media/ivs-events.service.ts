import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import type { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";

export interface IvsEnvelope {
  id: string;
  source: "aws.ivs";
  account: string;
  region: string;
  "detail-type": string;
  time: string;
  resources: string[];
  detail: Record<string, unknown>;
}
const types = new Set([
  "IVS Stage Update",
  "IVS Composition State Change",
  "IVS Participant Recording State Change",
  "IVS Publisher Recording State Change",
]);
export function parseIvsEvent(body: string, region: string): IvsEnvelope {
  if (Buffer.byteLength(body) > 262144) throw new Error("MALFORMED_EVENT");
  let event: IvsEnvelope;
  try {
    event = JSON.parse(body);
  } catch {
    throw new Error("MALFORMED_EVENT");
  }
  if (
    !event ||
    event.source !== "aws.ivs" ||
    event.region !== region ||
    typeof event.id !== "string" ||
    !/^[\w-]{1,100}$/.test(event.id) ||
    !/^\d{12}$/.test(event.account) ||
    !types.has(event["detail-type"]) ||
    !Array.isArray(event.resources) ||
    !event.resources.every((r) => typeof r === "string") ||
    typeof event.time !== "string" ||
    !Number.isFinite(Date.parse(event.time)) ||
    !event.detail ||
    typeof event.detail !== "object" ||
    Array.isArray(event.detail)
  )
    throw new Error("MALFORMED_EVENT");
  return event;
}

type Handler = (
  event: IvsEnvelope,
  tx: Prisma.TransactionClient,
) => Promise<void>;
@Injectable()
export class IvsEventsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly sqs: SQSClient;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private warningAt = 0;
  private readonly logger = new Logger(IvsEventsService.name);
  private readonly handlers = new Map<string, Handler>();
  constructor(
    private readonly db: PrismaService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {
    this.sqs = new SQSClient({
      region: config.ivs?.region ?? "ap-northeast-1",
      credentials: config.ivs?.credentials,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 15000 },
    });
  }
  // T11 registers a handler that writes durable jobs in the supplied transaction.
  // Network calls belong in that module's separate job worker.
  register(detailType: string, handler: Handler) {
    if (
      !types.has(detailType) ||
      detailType === "IVS Stage Update" ||
      this.handlers.has(detailType)
    )
      throw new Error("INVALID_IVS_HANDLER");
    this.handlers.set(detailType, handler);
  }
  onApplicationBootstrap() {
    if (!this.config.ivs?.workerEnabled) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }
  async ingest(body: string) {
    const event = parseIvsEvent(
      body,
      this.config.ivs?.region ?? "ap-northeast-1",
    );
    const stageArn =
      typeof event.detail.stage_arn === "string"
        ? event.detail.stage_arn
        : event.resources.find((r) => r.includes(":stage/"));
    if (
      !stageArn ||
      !stageArn.startsWith(
        `arn:aws:ivs:${event.region}:${event.account}:stage/`,
      )
    )
      throw new Error("MALFORMED_EVENT");
    if (
      this.config.ivs?.eventsQueueUrl &&
      new URL(this.config.ivs.eventsQueueUrl).pathname.split("/")[1] !==
        event.account
    )
      throw new Error("INVALID_EVENT_ACCOUNT");
    const room = await this.db.classMediaRoom.findUnique({
      where: { stageArn },
    });
    if (!room) throw new Error("UNKNOWN_STAGE");
    await this.db.ivsEvent.upsert({
      where: { id: event.id },
      create: {
        id: event.id,
        sessionId: room.sessionId,
        detailType: event["detail-type"],
        occurredAt: new Date(event.time),
        payload: event as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
    // Publish/unpublish events are observations, never permission or presence.
    // Reconciliation uses ListParticipants, so late events cannot resurrect users.
    if (event["detail-type"] === "IVS Stage Update") {
      await this.db.$transaction(async (tx) => {
        await tx.classMediaRoom.updateMany({
          where: { sessionId: room.sessionId, checkedAt: { lte: new Date() } },
          data: { checkedAt: new Date(0) },
        });
        await tx.ivsEvent.update({
          where: { id: event.id },
          data: { handledAt: new Date() },
        });
      });
    }
    return event.id;
  }
  async drain() {
    const pending = await this.db.ivsEvent.findMany({
      where: { handledAt: null, detailType: { in: [...this.handlers.keys()] } },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: 20,
    });
    for (const item of pending) {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM ivs_events WHERE id = ${item.id} FOR UPDATE`;
        const current = await tx.ivsEvent.findUniqueOrThrow({
          where: { id: item.id },
        });
        if (current.handledAt) return;
        await this.handlers.get(current.detailType)!(
          current.payload as unknown as IvsEnvelope,
          tx,
        );
        await tx.ivsEvent.update({
          where: { id: item.id },
          data: { handledAt: new Date() },
        });
      });
    }
  }
  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const queueUrl = this.config.ivs?.eventsQueueUrl;
      if (!queueUrl) return;
      const page = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          WaitTimeSeconds: 5,
          VisibilityTimeout: 60,
          MaxNumberOfMessages: 10,
        }),
      );
      for (const message of page.Messages ?? []) {
        if (this.stopping) break;
        try {
          if (!message.Body || !message.ReceiptHandle)
            throw new Error("MALFORMED_EVENT");
          await this.ingest(message.Body);
          await this.sqs.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        } catch {
          this.warn();
        } // SQS retries and redrives to DLQ; never ACK failed ingest.
      }
      await this.drain();
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
        "Sự kiện IVS chưa được xử lý; kiểm tra queue, DLQ, mapping Stage và IAM.",
      );
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
    this.sqs.destroy();
  }
}
