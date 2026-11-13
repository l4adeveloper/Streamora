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
  FOLDER_NOT_FOUND: "Thư mục không còn tồn tại. Hãy làm mới danh sách.",
  FOLDER_EXISTS: "Tên thư mục đã tồn tại. Hãy chọn tên khác.",
  FOLDER_BUSY:
    "Thư mục còn file đang tải lên. Hãy chờ hoàn tất hoặc hủy các lượt tải trước.",
  MEDIA_UNAVAILABLE: "Phòng video chưa sẵn sàng. Vui lòng thử lại sau.",
  MEDIA_STARTING:
    "Phòng video đang được chuẩn bị. Vui lòng thử lại sau vài giây.",
  MEDIA_REVOKING: "Kết nối cũ đang được đóng. Vui lòng thử lại sau vài giây.",
  MEDIA_REVOKED: "Quyền kết nối video đã kết thúc.",
  MEDIA_REQUEST_EXPIRED:
    "Yêu cầu kết nối đã hết hiệu lực. Hãy bấm kết nối để thử lại.",
  STALE_MEDIA_REQUEST:
    "Yêu cầu kết nối đã được thay thế. Hãy thử lại bằng thao tác mới.",
  BANNED: "Bạn đã bị chặn khỏi buổi học này.",
  UPLOAD_LOCAL_STORAGE_UNAVAILABLE:
    "Không thể lưu file để tiếp tục sau reload. Hãy kiểm tra dung lượng trống hoặc quyền lưu trữ của trình duyệt.",
  UPLOAD_RESUME_UNAVAILABLE:
    "API đang chạy chưa hỗ trợ tiếp tục tải lên. Hãy khởi động lại API bằng phiên bản mới.",
  UPLOAD_NOT_FOUND: "Không tìm thấy phiên tải lên. Hãy chọn file để tải lại.",
  UPLOAD_EXPIRED:
    "Phiên tải lên đã hết hạn. Hãy hủy phiên rồi chọn file để tải lại.",
  UPLOAD_NOT_ACTIVE:
    "Phiên đang xử lý hoặc đã kết thúc. Hãy kiểm tra trạng thái trước khi tiếp tục.",
  UPLOAD_FILE_MISMATCH:
    "File không khớp phiên tải lên. Hãy chọn lại đúng file ban đầu.",
  PDF_PREVIEW_UNSUPPORTED:
    "Chỉ hỗ trợ xem trước PDF và ảnh JPEG, PNG, WebP hợp lệ.",
  IMAGE_PREVIEW_UNSUPPORTED:
    "Nội dung ảnh không hợp lệ. Hãy kiểm tra lại file.",
  VIDEO_PREVIEW_UNSUPPORTED:
    "Video không tương thích để xem trước. Hãy thử MP4 (H.264/AAC), WebM hoặc tải file xuống.",
  VIDEO_OUTPUT_INVALID: "Các phiên bản video chưa sẵn sàng. Hãy thử lại sau.",
  FILE_TOO_LARGE: "File vượt quá kích thước cho phép.",
  UNSUPPORTED_TYPE:
    "Loại file chưa được hỗ trợ. Hãy chọn tài liệu, ảnh, video hoặc âm thanh phù hợp.",
  FILE_NOT_FOUND: "Tài liệu không tồn tại hoặc đã bị xóa.",
  FILE_NOT_READY: "Tài liệu đang được chuẩn bị. Vui lòng thử lại sau.",
  FILE_IN_USE:
    "Tài liệu đang được tải lên, xử lý hoặc liên kết với bản ghi nên chưa thể xóa.",
  STORAGE_UNAVAILABLE: "Chưa thể kết nối kho tài liệu. Vui lòng thử lại sau.",
  UPLOAD_QUOTA_EXCEEDED:
    "Đã đạt giới hạn tải lên đồng thời. Hãy đợi hoặc hủy file đang tải rồi thử lại.",
  UPLOAD_BUSY: "File đang được xử lý. Vui lòng thử lại sau.",
  FILE_CHANGED: "Vị trí file đã thay đổi. Vui lòng mở lại file.",
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
    "Nội dung thao tác đã thay đổi. Vui lòng kiểm tra và thử lại.",
  SESSION_NOT_FOUND: "Buổi học không tồn tại hoặc mã cuộc họp không đúng.",
  SESSION_NOT_EDITABLE: "Chỉ chỉnh sửa được buổi học chưa bắt đầu.",
  SESSION_NOT_LIVE:
    "Buổi học chưa bắt đầu hoặc đã kết thúc. Vui lòng làm mới trạng thái.",
  INVALID_SESSION_STATE:
    "Trạng thái buổi học đã thay đổi. Vui lòng làm mới trước khi tiếp tục.",
  JOIN_REQUEST_NOT_FOUND: "Yêu cầu tham gia không còn tồn tại.",
  JOIN_REQUEST_ALREADY_RESOLVED:
    "Yêu cầu đã được xử lý hoặc không còn hiệu lực. Danh sách sẽ được cập nhật.",
  JOIN_REQUEST_NOT_REQUIRED:
    "Bạn đã có thể vào phòng hoặc đang tham gia. Vui lòng kiểm tra trạng thái mới nhất.",
  ADMISSION_REQUIRED: "Bạn cần được chấp nhận trước khi vào phòng.",
  ADMISSION_REVOKED:
    "Lượt tham gia cũ đã hết hiệu lực. Hãy xin vào lại nếu muốn tiếp tục.",
  PARTICIPATION_NOT_FOUND:
    "Không tìm thấy lượt tham gia này. Vui lòng làm mới trạng thái.",
  ACTIVE_SESSION:
    "Nhóm còn buổi học đang diễn ra. Cần kết thúc buổi học trước khi xóa nhóm.",
};

export interface AuthRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
  responseType?: "blob";
}

export async function authRequest<T>(
  path: string,
  options: AuthRequestOptions = {},
): Promise<T> {
  const base = (
    process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000/api/v1"
  ).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.responseType === "blob" ? 600000 : 15000,
  );
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
    if (response.ok && options.responseType === "blob")
      return (await response.blob()) as T;
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
