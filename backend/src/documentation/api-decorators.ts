import { applyDecorators, type Type } from "@nestjs/common";
import {
  ApiExtraModels,
  ApiHeader,
  ApiResponse,
  getSchemaPath,
} from "@nestjs/swagger";
import { ApiErrorResponseDto } from "./api-models";

const requestIdHeader = {
  description: "ID request do server tạo.",
  schema: { type: "string", format: "uuid" },
};
const commonHeaders = {
  "X-Request-ID": requestIdHeader,
  "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
};
export function ApiSuccess(
  status: number,
  type?: Type<unknown>,
  cookie = false,
) {
  return ApiResponse({
    status,
    ...(type ? { type } : {}),
    description:
      status === 204
        ? "Không có response body. Logout lặp vẫn trả 204."
        : "Thành công.",
    headers: {
      ...commonHeaders,
      ...(cookie
        ? {
            "Set-Cookie": {
              description:
                "refreshToken do browser quản lý: HttpOnly, host-only, Path=/api/v1/auth. Secure/SameSite theo môi trường; logout xóa cookie.",
              schema: { type: "string" },
            },
          }
        : {}),
    },
  });
}

export function ApiErrors(...errors: Array<[number, ...string[]]>) {
  return applyDecorators(
    ApiExtraModels(ApiErrorResponseDto),
    ...errors.map(([status, ...codes]) =>
      ApiResponse({
        status,
        description: codes.join(" / "),
        schema: { $ref: getSchemaPath(ApiErrorResponseDto) },
        headers: {
          ...commonHeaders,
          ...(status === 429
            ? {
                "Retry-After": {
                  description: "Số giây cần chờ trước khi thử lại.",
                  schema: { type: "integer", minimum: 1 },
                },
              }
            : {}),
        },
      }),
    ),
    ApiResponse({
      status: 500,
      description: "INTERNAL_ERROR — không trả stack/secret.",
      type: ApiErrorResponseDto,
      headers: commonHeaders,
    }),
    ApiResponse({
      status: 503,
      description: "SERVICE_UNAVAILABLE — có thể thử lại thao tác đọc.",
      type: ApiErrorResponseDto,
      headers: commonHeaders,
    }),
  );
}

export function ApiAuthOrigin() {
  return ApiHeader({
    name: "Origin",
    required: true,
    description:
      "Phải khớp chính xác WEB_ORIGIN, kể cả PowerShell/Postman. Trình duyệt tự đặt header này; không cho giả Origin từ Swagger trên host API.",
    example: "http://127.0.0.1:3000",
  });
}
