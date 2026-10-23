import { Injectable } from "@nestjs/common";
import {
  CLASS_SESSION_ENDED_EVENT,
  type ClassSessionEndedMessage,
} from "@streamora/contracts";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";
import { classServerTime } from "../../database/class-presence";

export type ClassSessionEndedHandler = (
  message: ClassSessionEndedMessage,
  tx: Prisma.TransactionClient,
) => Promise<void>;

@Injectable()
export class ClassSessionEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Handler DB effects and checkpoint share one transaction. A thrown error retries
   * the same eventId later. External effects still require downstream deduplication.
   */
  consumeNext(
    consumer: string,
    handler: ClassSessionEndedHandler,
  ): Promise<ClassSessionEndedMessage | null> {
    if (
      typeof consumer !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(consumer)
    )
      throw new ApiError(400, "VALIDATION_ERROR", "Tên consumer không hợp lệ.");
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`INSERT INTO class_session_end_consumers (name) VALUES (${consumer}) ON CONFLICT (name) DO NOTHING`;
        await tx.$queryRaw`SELECT name FROM class_session_end_consumers WHERE name = ${consumer} FOR UPDATE`;
        const checkpoint = await tx.classSessionEndConsumer.findUniqueOrThrow({
          where: { name: consumer },
        });
        const row = await tx.classSessionEndEvent.findFirst({
          where: { version: { gt: checkpoint.lastVersion } },
          orderBy: { version: "asc" },
        });
        if (!row) return null;
        const message: ClassSessionEndedMessage = {
          type: CLASS_SESSION_ENDED_EVENT,
          payload: {
            eventId: row.eventId,
            sessionId: row.sessionId,
            endedAt: row.endedAt.toISOString(),
            version: row.version.toString(),
          },
        };
        await handler(message, tx);
        await tx.classSessionEndConsumer.update({
          where: { name: consumer },
          data: {
            lastVersion: row.version,
            updatedAt: await classServerTime(tx),
          },
        });
        return message;
      },
      { maxWait: 5000, timeout: 10000 },
    );
  }

  async consumeBatch(
    consumer: string,
    handler: ClassSessionEndedHandler,
    limit = 25,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Giới hạn consumer phải từ 1 đến 100.",
      );
    let processed = 0;
    while (processed < limit && (await this.consumeNext(consumer, handler)))
      processed++;
    return processed;
  }
}
