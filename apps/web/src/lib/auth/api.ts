import "client-only";
import type { ApiErrorResponse } from "@streamora/contracts";

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

const messages: Record<string, string> = {
  EMAIL_EXISTS:
    "Email này đã được sử dụng. Bạn có thể đăng nhập hoặc dùng email khác.",
  INVALID_CREDENTIALS: "Email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.",
  USER_DISABLED: "Tài khoản đã bị khóa. Vui lòng liên hệ người quản trị.",
  UNAUTHENTICATED: "Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.",
  REFRESH_EXPIRED: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  REFRESH_REUSED: "Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.",
  VALIDATION_ERROR: "Vui lòng kiểm tra lại thông tin đã nhập.",
  ORIGIN_NOT_ALLOWED: "Không thể xác thực yêu cầu. Vui lòng tải lại trang.",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
  GROUP_NOT_FOUND: "Nhóm không tồn tại hoặc đã bị xóa.",
  USER_NOT_FOUND: "Không tồn tại người dùng với email này.",
  MEMBER_NOT_FOUND:
    "Thành viên không còn trong nhóm. Vui lòng làm mới danh sách.",
  ALREADY_MEMBER: "Người dùng đã là thành viên của nhóm.",
  OWNER_PROTECTED: "Không thể xóa hoặc đổi vai trò chủ nhóm.",
  RATE_LIMITED: "Bạn đã thao tác quá nhiều. Vui lòng thử lại sau một phút.",
  GROUP_NAME_EXISTS: "Bạn đã có nhóm mang tên này. Vui lòng chọn tên khác.",
  INVALID_CURSOR: "Không thể tải trang tiếp theo. Vui lòng làm mới danh sách.",
  IDEMPOTENCY_CONFLICT:
    "Yêu cầu tạo nhóm đã thay đổi. Vui lòng kiểm tra và thử lại.",
};

export interface AuthRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
}

export async function authRequest<T>(
  path: string,
  options: AuthRequestOptions = {},
): Promise<T> {
  const base = (
    process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000/api/v1"
  ).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "POST",
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload =
      response.status === 204
        ? undefined
        : await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = payload as Partial<ApiErrorResponse> | undefined;
      const code =
        typeof error?.error?.code === "string"
          ? error.error.code
          : "SERVICE_UNAVAILABLE";
      const fields: Record<string, string> = {};
      const issues = error?.error?.details?.fields;
      if (Array.isArray(issues))
        for (const issue of issues.slice(0, 30)) {
          if (
            typeof issue?.field === "string" &&
            /^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/.test(issue.field) &&
            !["__proto__", "constructor", "prototype"].includes(issue.field) &&
            typeof issue.message === "string"
          )
            fields[issue.field] ??= issue.message.slice(0, 300);
        }
      if (code === "EMAIL_EXISTS")
        fields.email = "Email đã có tài khoản. Vui lòng dùng email khác.";
      if (code === "GROUP_NAME_EXISTS")
        fields.name = messages.GROUP_NAME_EXISTS;
      const retry = Number(response.headers.get("retry-after"));
      const message =
        code === "RATE_LIMITED"
          ? `Bạn đã thử quá nhiều lần. ${Number.isFinite(retry) && retry > 0 && retry <= 86400 ? `Vui lòng thử lại sau ${Math.ceil(retry)} giây.` : "Vui lòng thử lại sau."}`
          : (messages[code] ??
            (response.status === 403
              ? messages.FORBIDDEN
              : response.status === 401
                ? messages.UNAUTHENTICATED
                : "Dịch vụ tạm thời chưa sẵn sàng. Vui lòng thử lại sau."));
      throw new AuthApiError(
        response.status,
        code,
        message,
        fields,
        typeof error?.requestId === "string" ? error.requestId : undefined,
      );
    }
    if (response.status !== 204 && payload === undefined)
      throw new Error("Invalid API response");
    return payload as T;
  } catch (error) {
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(
      0,
      "NETWORK_ERROR",
      "Không thể kết nối đến máy chủ. Vui lòng kiểm tra kết nối và thử lại.",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function asAuthError(error: unknown): AuthApiError {
  return error instanceof AuthApiError
    ? error
    : new AuthApiError(
        0,
        "UNKNOWN_ERROR",
        "Chưa thể hoàn tất thao tác. Vui lòng thử lại.",
      );
}
