import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
export class LibraryFileDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) groupId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: Number, minimum: 0 }) size!: number;
  @ApiProperty() mimeType!: string;
  @ApiProperty({ enum: ["DOCUMENT", "LOCAL_RECORDING", "CLOUD_RECORDING"] })
  source!: string;
  @ApiProperty({ enum: ["PENDING", "AVAILABLE", "DELETED"] }) status!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: "uuid" })
  sessionId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: "uuid" })
  recordingId!: string | null;
  @ApiProperty({ format: "uuid" }) createdBy!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}
export class FileResponseDto {
  @ApiProperty({ type: LibraryFileDto }) file!: LibraryFileDto;
}
export class FileListResponseDto {
  @ApiProperty({ type: [LibraryFileDto] }) items!: LibraryFileDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class FileDownloadResponseDto {
  @ApiProperty() url!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}
