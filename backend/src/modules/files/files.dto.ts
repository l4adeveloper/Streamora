import { Transform } from "class-transformer";
import {
  IsIn,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class FileListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  @Matches(/^(?:[^\/\\\x00-\x1f\x7f]+(?:\/[^\/\\\x00-\x1f\x7f]+)*)?$/u)
  folderPath?: string;
  @ApiPropertyOptional({ maxLength: 255 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(255)
  q?: string;
  @ApiPropertyOptional({ enum: ["document", "video"] })
  @IsOptional()
  @IsIn(["document", "video"])
  type?: "document" | "video";
}
export class RenameFileDto {
  @ApiProperty({ minLength: 1, maxLength: 255 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 255)
  @Matches(/^[^\x00-\x1f\x7f]+$/u)
  name!: string;
}

// Compatibility for T03 consumers; canonical T15 list takes groupId in path.
export class LegacyFileListQueryDto extends FileListQueryDto {
  @IsUUID()
  groupId!: string;
}

export class FolderDto {
  @ApiProperty()
  @IsString()
  @Length(1, 2048)
  @Matches(
    /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\/\\\x00-\x1f\x7f]+(?:\/[^\/\\\x00-\x1f\x7f]+)*$/u,
  )
  folderPath!: string;
}
export class ChangeFolderDto extends FolderDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
export class RenameFolderDto extends ChangeFolderDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 255)
  @Matches(/^(?!\.{1,2}$)[^\/\\\x00-\x1f\x7f]+$/u)
  name!: string;
}
