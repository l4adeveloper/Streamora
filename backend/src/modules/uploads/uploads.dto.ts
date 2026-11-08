import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateUploadDto {
  @ApiProperty() @IsUUID() groupId!: string;
  @ApiProperty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 255)
  @Matches(/^[^/\\\x00-\x1f\x7f]+$/u)
  filename!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) size!: number;
  @ApiProperty() @IsString() @Length(1, 255) mimeType!: string;
  @ApiProperty() @IsString() @Length(1, 200) fingerprint!: string;
  @ApiProperty({ enum: ["DOCUMENT", "LOCAL_RECORDING"] })
  @IsIn(["DOCUMENT", "LOCAL_RECORDING"])
  source!: "DOCUMENT" | "LOCAL_RECORDING";
  @ApiPropertyOptional() @IsOptional() @IsUUID() sessionId?: string;
}
export class SignPartsDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10000, { each: true })
  partNumbers!: number[];
}
export class UploadPartDto {
  @ApiProperty() @IsInt() @Min(1) @Max(10000) partNumber!: number;
  @ApiProperty() @IsString() @Length(1, 200) etag!: string;
}
export class CompleteUploadDto {
  @ApiProperty({ type: [UploadPartDto] })
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts!: UploadPartDto[];
}
