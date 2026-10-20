import type { UpdateProfileRequest } from "@streamora/contracts";
import { FullNameField } from "../../common/dto/validation.decorators";
import { ApiProperty } from "@nestjs/swagger";
import { AUTH_CONSTRAINTS } from "@streamora/contracts";

export class UpdateProfileDto implements UpdateProfileRequest {
  @ApiProperty({
    minLength: AUTH_CONSTRAINTS.fullNameMinLength,
    maxLength: AUTH_CONSTRAINTS.fullNameMaxLength,
    example: "Nguyễn Minh Anh",
    description: "Chỉ nhận fullName; trim trước khi lưu.",
  })
  @FullNameField()
  fullName!: string;
}
