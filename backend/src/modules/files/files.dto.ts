import { Transform } from "class-transformer";
import {
  IsIn,
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
  @ApiPropertyOptional({ description: "Folder UUID or 'root'" })
  @IsOptional()
  @IsString()
  folderId?: string;
}
export class RenameFileDto {
  @ApiProperty({ minLength: 1, maxLength: 255 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 255)
  @Matches(/^[^\x00-\x1f\x7f]+$/u)
  name!: string;
}

export class CreateFolderDto {
  @ApiProperty({ minLength: 1, maxLength: 255 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 255)
  @Matches(/^[^\x00-\x1f\x7f]+$/u)
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) =>
    !value || value === "root" || value === "null" ? null : value,
  )
  @IsUUID()
  parentId?: string | null;
}

export class RenameFolderDto {
  @ApiProperty({ minLength: 1, maxLength: 255 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 255)
  @Matches(/^[^\x00-\x1f\x7f]+$/u)
  name!: string;
}

export class MoveFileDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) =>
    !value || value === "root" || value === "null" ? null : value,
  )
  @IsUUID()
  destinationFolderId?: string | null;
}

export class ListFoldersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentId?: string;
}

// Compatibility for T03 consumers; canonical T15 list takes groupId in path.
export class LegacyFileListQueryDto extends FileListQueryDto {
  @IsUUID()
  groupId!: string;
}
