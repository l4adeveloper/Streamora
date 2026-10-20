import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiErrorDetails, ApiErrorResponse } from "@streamora/contracts";
import { Prisma } from "../generated/prisma/client";
import { requestId, type ApiRequest } from "./http-context";

export class ApiError extends HttpException {
  constructor(
    status: number,
    code: string,
    message: string,
    details?: ApiErrorDetails,
  ) {
    super(
      { error: { code, message, ...(details ? { details } : {}) } },
      status,
    );
  }
}

const FALLBACKS: Record<number, { code: string; message: string }> = {
  400: { code: "VALIDATION_ERROR", message: "Dữ liệu không hợp lệ." },
  401: { code: "UNAUTHENTICATED", message: "Bạn cần đăng nhập." },
  403: {
    code: "FORBIDDEN",
    message: "Bạn không có quyền thực hiện thao tác này.",
  },
  404: { code: "NOT_FOUND", message: "Không tìm thấy tài nguyên." },
  409: { code: "CONFLICT", message: "Dữ liệu hoặc trạng thái có xung đột." },
  410: { code: "GONE", message: "Tài nguyên đã hết hạn." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "Dữ liệu gửi lên quá lớn." },
  415: {
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "Định dạng dữ liệu không được hỗ trợ.",
  },
  429: {
    code: "RATE_LIMITED",
    message: "Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
  },
  503: {
    code: "SERVICE_UNAVAILABLE",
    message: "Dịch vụ tạm thời chưa sẵn sàng.",
  },
  500: { code: "INTERNAL_ERROR", message: "Không thể xử lý yêu cầu." },
};

function errorStatus(error: unknown): number {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= 400 && status <= 599 ? status : 500;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (
      ["P1001", "P1002", "P1008", "P1017", "P2024", "P2037"].includes(
        error.code,
      )
    )
      return 503;
    if (["P2002", "P2003", "P2034"].includes(error.code)) return 409;
    if (error.code === "P2025") return 404;
  }
  return 500;
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    const request = host.switchToHttp().getRequest<ApiRequest>();
    const status = errorStatus(error);
    const payload =
      error instanceof ApiError
        ? (error.getResponse() as Pick<ApiErrorResponse, "error">)
        : { error: FALLBACKS[status] ?? FALLBACKS[500] };
    // Never serialize/log exception objects: database/crypto errors can contain input.
    const body: ApiErrorResponse = {
      ...payload,
      requestId: requestId(request, response),
    };
    response.status(status).json(body);
  }
}
