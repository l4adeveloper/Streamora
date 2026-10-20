import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";
import {
  PAGINATION_DEFAULTS,
  type PaginationRequest,
} from "@streamora/contracts";

export class PaginationQueryDto implements PaginationRequest {
  @IsOptional()
  @IsString()
  @Length(1, PAGINATION_DEFAULTS.maxCursorLength)
  cursor?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : value,
  )
  @IsInt()
  @Min(1)
  @Max(PAGINATION_DEFAULTS.maxLimit)
  limit: number = PAGINATION_DEFAULTS.limit;
}
