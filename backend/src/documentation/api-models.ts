import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type {
  User,
  UserResponse,
  AccessTokenResponse,
  LoginResponse,
  ApiErrorResponse,
  ValidationIssue,
  GlobalRole,
} from "@streamora/contracts";
import { AUTH_CONSTRAINTS } from "@streamora/contracts";

export class PublicUserDto implements User {
  @ApiProperty({
    format: "uuid",
    example: "d9c0fb32-dc39-4c7e-8652-c30e9fc4135e",
  })
  id!: string;

  @ApiProperty({
    format: "email",
    maxLength: AUTH_CONSTRAINTS.emailMaxLength,
    example: "user@example.test",
  })
  email!: string;

  @ApiProperty({
    minLength: AUTH_CONSTRAINTS.fullNameMinLength,
    maxLength: AUTH_CONSTRAINTS.fullNameMaxLength,
    example: "Nguyễn Minh Anh",
  })
  fullName!: string;

  @ApiProperty({ enum: ["USER", "ADMIN"], enumName: "GlobalRole" })
  globalRole!: GlobalRole;
}

export class UserResponseDto implements UserResponse {
  @ApiProperty({ type: PublicUserDto })
  user!: PublicUserDto;
}

export class AccessTokenResponseDto implements AccessTokenResponse {
  @ApiProperty({
    description: "JWT ngắn hạn. Chỉ giữ trong bộ nhớ client.",
    readOnly: true,
  })
  accessToken!: string;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    example: 900,
    description:
      "Thời gian sống access token, tính bằng giây theo cấu hình server.",
  })
  expiresIn!: number;
}

export class LoginResponseDto
  extends AccessTokenResponseDto
  implements LoginResponse
{
  @ApiProperty({ type: PublicUserDto })
  user!: PublicUserDto;
}

export class ValidationIssueDto implements ValidationIssue {
  @ApiProperty({ example: "fullName" })
  field!: string;

  @ApiProperty({ example: "INVALID_LENGTH" })
  code!: ValidationIssue["code"];

  @ApiProperty({ example: "Họ tên phải có từ 1 đến 100 ký tự." })
  message!: string;
}

export class ErrorDetailsDto {
  @ApiPropertyOptional({ type: [ValidationIssueDto] })
  fields?: ValidationIssueDto[];
  [key: string]: unknown;
}

export class ErrorBodyDto {
  @ApiProperty({ example: "VALIDATION_ERROR" })
  code!: string;

  @ApiProperty({ example: "Dữ liệu yêu cầu không hợp lệ." })
  message!: string;

  @ApiPropertyOptional({ type: ErrorDetailsDto })
  details?: ErrorDetailsDto;
}

export class ApiErrorResponseDto implements ApiErrorResponse {
  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;

  @ApiProperty({
    format: "uuid",
    description: "Trùng header X-Request-ID của response.",
  })
  requestId!: string;
}
