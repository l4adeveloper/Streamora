import { ValidationPipe } from "@nestjs/common";
import type { ValidationError } from "class-validator";
import type {
  ValidationIssue,
  ValidationIssueCode,
} from "@streamora/contracts";
import { ApiError } from "./api-error";

const RULES: Record<string, [ValidationIssueCode, string]> = {
  isEmail: ["INVALID_EMAIL", "Email không hợp lệ."],
  isString: ["INVALID_TYPE", "Giá trị phải là chuỗi ký tự."],
  isLength: ["INVALID_LENGTH", "Độ dài không hợp lệ."],
  maxLength: ["TOO_LONG", "Giá trị vượt quá độ dài cho phép."],
  minLength: ["TOO_SHORT", "Giá trị chưa đủ độ dài yêu cầu."],
  isInt: ["INVALID_INTEGER", "Giá trị phải là số nguyên."],
  min: ["BELOW_MINIMUM", "Giá trị nhỏ hơn mức cho phép."],
  max: ["ABOVE_MAXIMUM", "Giá trị lớn hơn mức cho phép."],
  isUuid: ["INVALID_ID", "ID phải là UUID hợp lệ."],
  isDefined: ["REQUIRED", "Trường này là bắt buộc."],
  isNotEmpty: ["REQUIRED", "Trường này là bắt buộc."],
};

export function validationIssues(errors: ValidationError[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const visit = (items: ValidationError[], parent = "", depth = 0) => {
    if (depth > 4) return;
    for (const error of items) {
      const safeName =
        typeof error.property === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,63}$|^\d{1,6}$/.test(error.property)
          ? error.property
          : "_form";
      const field = parent ? `${parent}.${safeName}` : safeName;
      for (const rule of Object.keys(error.constraints ?? {})) {
        const unknownField = rule === "whitelistValidation";
        const path = unknownField ? "_form" : field;
        const [code, message] = unknownField
          ? ([
              "UNEXPECTED_FIELD",
              "Yêu cầu chứa trường không được phép.",
            ] as const)
          : (RULES[rule] ?? ["INVALID_VALUE", "Giá trị không hợp lệ."]);
        const key = `${path}:${code}`;
        if (!seen.has(key) && issues.length < 30) {
          issues.push({ field: path, code, message });
          seen.add(key);
        }
      }
      visit(error.children ?? [], field, depth + 1);
      if (issues.length >= 30) return;
    }
  };
  visit(errors);
  return issues;
}

export function createValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new ApiError(
        400,
        "VALIDATION_ERROR",
        "Dữ liệu không hợp lệ hoặc có trường không được phép.",
        { fields: validationIssues(errors) },
      ),
  });
}
