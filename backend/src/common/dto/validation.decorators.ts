import { applyDecorators } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsEmail, IsString, Length, MaxLength } from "class-validator";
import { AUTH_CONSTRAINTS } from "@streamora/contracts";

export function EmailField() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === "string" ? value.trim().toLowerCase() : value,
    ),
    IsEmail({ allow_utf8_local_part: false }),
    MaxLength(AUTH_CONSTRAINTS.emailMaxLength),
  );
}

export function FullNameField() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === "string" ? value.trim() : value,
    ),
    IsString(),
    Length(
      AUTH_CONSTRAINTS.fullNameMinLength,
      AUTH_CONSTRAINTS.fullNameMaxLength,
    ),
  );
}
