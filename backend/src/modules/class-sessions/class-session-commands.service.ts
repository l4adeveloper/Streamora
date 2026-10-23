import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client";
import { ApiError } from "../../common/api-error";

export type ClassSessionOperation =
  | "CREATE_GROUP"
  | "CREATE_MEET"
  | "START"
  | "END"
  | "CANCEL"
  | "REQUEST_JOIN"
  | "ENTER_SESSION";
type Tx = Prisma.TransactionClient;

@Injectable()
export class ClassSessionCommandsService {
  async prepare(
    tx: Tx,
    userId: string,
    operation: ClassSessionOperation,
    key: string | undefined,
    body: unknown,
    required = false,
  ) {
    if (
      (required && key === undefined) ||
      (key !== undefined && !/^[\x21-\x7e]{1,128}$/.test(key))
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Idempotency-Key phải có 1–128 ký tự ASCII không có khoảng trắng.",
      );
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
    if (!key) return { bodyHash, previous: null };
    const lockKey = `t04:${userId}:${operation}:${key}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
    const previous = await tx.classSessionCommand.findUnique({
      where: { userId_operation_key: { userId, operation, key } },
    });
    if (previous && previous.bodyHash !== bodyHash)
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Khóa đã được dùng với nội dung hoặc buổi học khác.",
      );
    return { bodyHash, previous };
  }

  async save(
    tx: Tx,
    userId: string,
    operation: ClassSessionOperation,
    key: string | undefined,
    bodyHash: string,
    sessionId: string,
    response: unknown,
  ) {
    if (key)
      await tx.classSessionCommand.create({
        data: {
          userId,
          operation,
          key,
          bodyHash,
          sessionId,
          response: response as Prisma.InputJsonValue,
        },
      });
  }
}
