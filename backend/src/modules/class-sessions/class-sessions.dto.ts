import {
  applyDecorators,
  Injectable,
  type PipeTransform,
} from "@nestjs/common";
import { Transform } from "class-transformer";
import {
  IsIn,
  IsISO8601,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  CLASS_SESSION_CONSTRAINTS,
  type CreateGroupClassSessionRequest,
  type CreateMeetRequest,
  type UpdateClassSessionRequest,
  type ClassSessionListRequest,
  type ClassSessionStatus,
} from "@streamora/contracts";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { ApiError } from "../../common/api-error";

export const SESSION_STATUSES = [
  "SCHEDULED",
  "LIVE",
  "ENDED",
  "CANCELLED",
] as const;
const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value,
);
const timestamp = () =>
  applyDecorators(
    IsString(),
    IsISO8601({ strict: true, strictSeparator: true }),
    Matches(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    ),
  );

class SessionContentDto {
  @ApiProperty({
    minLength: 1,
    maxLength: CLASS_SESSION_CONSTRAINTS.titleMaxLength,
  })
  @trim
  @IsString()
  @Length(1, CLASS_SESSION_CONSTRAINTS.titleMaxLength)
  title!: string;

  @ApiPropertyOptional({
    maxLength: CLASS_SESSION_CONSTRAINTS.descriptionMaxLength,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @trim
  @IsString()
  @MaxLength(CLASS_SESSION_CONSTRAINTS.descriptionMaxLength)
  description?: string;
}

export class CreateGroupClassSessionDto
  extends SessionContentDto
  implements CreateGroupClassSessionRequest
{
  @ApiProperty({
    format: "date-time",
    description: "ISO8601 có múi giờ; ví dụ 2026-10-25T19:00:00+07:00.",
  })
  @timestamp()
  scheduledAt!: string;
}

export class CreateMeetDto
  extends SessionContentDto
  implements CreateMeetRequest
{
  @ApiPropertyOptional({ format: "date-time" })
  @ValidateIf((_object, value) => value !== undefined)
  @timestamp()
  scheduledAt?: string;
}

export class UpdateClassSessionDto implements UpdateClassSessionRequest {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: CLASS_SESSION_CONSTRAINTS.titleMaxLength,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @trim
  @IsString()
  @Length(1, CLASS_SESSION_CONSTRAINTS.titleMaxLength)
  title?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: CLASS_SESSION_CONSTRAINTS.descriptionMaxLength,
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @trim
  @IsString()
  @MaxLength(CLASS_SESSION_CONSTRAINTS.descriptionMaxLength)
  description?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Chỉ meet độc lập được xóa lịch bằng null.",
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @timestamp()
  scheduledAt?: string | null;
}

export class ClassSessionListQueryDto
  extends PaginationQueryDto
  implements ClassSessionListRequest
{
  @ApiPropertyOptional({ enum: SESSION_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(SESSION_STATUSES)
  status?: ClassSessionStatus;
}

@Injectable()
export class EmptySessionActionPipe implements PipeTransform {
  transform(value: unknown) {
    if (
      value === undefined ||
      (value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    )
      return value;
    throw new ApiError(400, "VALIDATION_ERROR", "Thao tác chỉ nhận body rỗng.");
  }
}
