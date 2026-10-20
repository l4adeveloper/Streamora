import { IsString, Length } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import {
  AUTH_CONSTRAINTS,
  type RegisterRequest,
  type LoginRequest,
} from "@streamora/contracts";
import {
  EmailField,
  FullNameField,
} from "../../common/dto/validation.decorators";

export class RegisterDto implements RegisterRequest {
  @ApiProperty({
    format: "email",
    maxLength: AUTH_CONSTRAINTS.emailMaxLength,
    example: "user@example.test",
    description: "Trim/lowercase trước khi lưu; unique.",
  })
  @EmailField()
  email!: string;

  @ApiProperty({
    format: "password",
    writeOnly: true,
    minLength: AUTH_CONSTRAINTS.passwordMinLength,
    maxLength: AUTH_CONSTRAINTS.passwordMaxLength,
    description: "Giữ nguyên khoảng trắng và Unicode. Không log giá trị.",
  })
  @IsString()
  @Length(
    AUTH_CONSTRAINTS.passwordMinLength,
    AUTH_CONSTRAINTS.passwordMaxLength,
  )
  password!: string;

  @ApiProperty({
    minLength: AUTH_CONSTRAINTS.fullNameMinLength,
    maxLength: AUTH_CONSTRAINTS.fullNameMaxLength,
    example: "Nguyễn Minh Anh",
    description: "Trim, đếm Unicode code point.",
  })
  @FullNameField()
  fullName!: string;
}

export class LoginDto implements LoginRequest {
  @ApiProperty({
    format: "email",
    maxLength: AUTH_CONSTRAINTS.emailMaxLength,
    example: "user@example.test",
  })
  @EmailField()
  email!: string;

  @ApiProperty({
    format: "password",
    writeOnly: true,
    minLength: 1,
    maxLength: AUTH_CONSTRAINTS.passwordMaxLength,
  })
  @IsString()
  @Length(1, AUTH_CONSTRAINTS.passwordMaxLength)
  password!: string;
}

export { UpdateProfileDto } from "../users/profile.dto";
