import { AUTH_CONSTRAINTS } from "@streamora/contracts";

export type FieldErrors = Partial<
  Record<"email" | "password" | "fullName", string>
>;
export function nameError(value: string): string | undefined {
  const length = Array.from(value.trim()).length;
  if (length < AUTH_CONSTRAINTS.fullNameMinLength)
    return "Vui lòng nhập họ và tên.";
  if (length > AUTH_CONSTRAINTS.fullNameMaxLength)
    return "Họ và tên không được quá 100 ký tự.";
}
export function validateCredentials(
  email: string,
  password: string,
  registering: boolean,
): FieldErrors {
  const errors: FieldErrors = {};
  const normalized = email.trim().toLowerCase();
  if (!normalized) errors.email = "Vui lòng nhập email.";
  else if (
    normalized.length > AUTH_CONSTRAINTS.emailMaxLength ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  )
    errors.email = "Vui lòng nhập email hợp lệ.";
  const length = Array.from(password).length;
  if (!length) errors.password = "Vui lòng nhập mật khẩu.";
  else if (registering && length < AUTH_CONSTRAINTS.passwordMinLength)
    errors.password = "Mật khẩu cần ít nhất 12 ký tự.";
  else if (length > AUTH_CONSTRAINTS.passwordMaxLength)
    errors.password = "Mật khẩu không được quá 128 ký tự.";
  return errors;
}
