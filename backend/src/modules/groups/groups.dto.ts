import {
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateIf,
} from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { GROUP_CONSTRAINTS } from "@streamora/contracts";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class CreateGroupDto {
  @ApiProperty({
    description: "Tên nhóm học tập.",
    minLength: GROUP_CONSTRAINTS.nameMinLength,
    maxLength: GROUP_CONSTRAINTS.nameMaxLength,
    example: "Nhóm Điện toán đám mây K69",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @Length(GROUP_CONSTRAINTS.nameMinLength, GROUP_CONSTRAINTS.nameMaxLength)
  name!: string;

  @ApiPropertyOptional({
    description: "Mô tả ngắn về nhóm (tuỳ chọn).",
    maxLength: GROUP_CONSTRAINTS.descriptionMaxLength,
    example: "Nhóm học tập môn Điện toán đám mây — K69 UET 2026-2027.",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(GROUP_CONSTRAINTS.descriptionMaxLength)
  description?: string;
}

export class UpdateGroupDto {
  @ApiPropertyOptional({
    description: "Tên nhóm mới.",
    minLength: GROUP_CONSTRAINTS.nameMinLength,
    maxLength: GROUP_CONSTRAINTS.nameMaxLength,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(GROUP_CONSTRAINTS.nameMinLength, GROUP_CONSTRAINTS.nameMaxLength)
  name?: string;

  @ApiPropertyOptional({
    description: "Mô tả nhóm mới. Truyền null để xóa mô tả.",
    type: String,
    nullable: true,
    maxLength: GROUP_CONSTRAINTS.descriptionMaxLength,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(GROUP_CONSTRAINTS.descriptionMaxLength)
  description?: string | null;
}

export class GroupListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: "Tìm kiếm theo tên nhóm.",
    maxLength: GROUP_CONSTRAINTS.searchMaxLength,
    example: "điện toán",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(GROUP_CONSTRAINTS.searchMaxLength)
  q?: string;
}
