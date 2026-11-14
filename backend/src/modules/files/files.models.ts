import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
export class LibraryFileDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) groupId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() folderPath!: string;
  @ApiProperty({ type: Number, minimum: 0 }) size!: number;
  @ApiProperty() mimeType!: string;
  @ApiPropertyOptional() canDownload?: boolean;
  @ApiProperty({ enum: ["DOCUMENT", "LOCAL_RECORDING", "CLOUD_RECORDING"] })
  source!: string;
  @ApiProperty({ enum: ["PENDING", "AVAILABLE", "DELETED"] }) status!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: "uuid" })
  sessionId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: "uuid" })
  recordingId!: string | null;
  @ApiProperty({ format: "uuid" }) createdBy!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: Boolean, default: true }) isPublished!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true, format: "date-time" })
  publishedAt!: string | null;
}
export class FileResponseDto {
  @ApiProperty({ type: LibraryFileDto }) file!: LibraryFileDto;
}
export class FileListResponseDto {
  @ApiProperty({ type: [LibraryFileDto] }) items!: LibraryFileDto[];
  @ApiProperty({ type: [String] }) folders!: string[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class FileDownloadResponseDto {
  @ApiProperty() url!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}
class VideoSourceDto extends FileDownloadResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ["file", "hls"] }) kind!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({ type: Number, nullable: true }) bitrate!: number | null;
}
class VideoProcessingDto {
  @ApiProperty({
    enum: ["NOT_REQUESTED", "QUEUED", "PROCESSING", "READY", "FAILED"],
  })
  status!: string;
  @ApiProperty({ type: Number, nullable: true }) progressPercent!:
    number | null;
}
export class VideoPlaybackResponseDto {
  @ApiProperty({ format: "uuid" }) fileId!: string;
  @ApiProperty({ type: VideoProcessingDto }) processing!: VideoProcessingDto;
  @ApiProperty({ type: [VideoSourceDto] }) sources!: VideoSourceDto[];
  @ApiPropertyOptional({ type: [Object] }) qualities?: object[];
  @ApiPropertyOptional() thumbnail?: string;
  @ApiPropertyOptional() grantUrl?: string;
}
