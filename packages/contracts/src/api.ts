export const PAGINATION_DEFAULTS = Object.freeze({
  limit: 20,
  maxLimit: 100,
  maxCursorLength: 2048,
});

export interface PaginationRequest {
  cursor?: string;
  limit?: number;
}
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type ValidationIssueCode =
  | "INVALID_TYPE"
  | "INVALID_EMAIL"
  | "INVALID_LENGTH"
  | "TOO_LONG"
  | "TOO_SHORT"
  | "INVALID_INTEGER"
  | "BELOW_MINIMUM"
  | "ABOVE_MAXIMUM"
  | "INVALID_ID"
  | "REQUIRED"
  | "UNEXPECTED_FIELD"
  | "INVALID_VALUE";

export interface ValidationIssue {
  /** DTO property path, or _form for unknown input fields. Never an input value. */
  field: string;
  code: ValidationIssueCode;
  message: string;
}
export interface ApiErrorDetails {
  fields?: ValidationIssue[];
  [key: string]: unknown;
}
export interface ApiErrorResponse<Code extends string = string> {
  error: { code: Code; message: string; details?: ApiErrorDetails };
  requestId: string;
}

export type CommonErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "GONE"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";
export type AuthErrorCode =
  | "EMAIL_EXISTS"
  | "INVALID_CREDENTIALS"
  | "USER_DISABLED"
  | "REFRESH_EXPIRED"
  | "REFRESH_REUSED"
  | "ORIGIN_NOT_ALLOWED";
