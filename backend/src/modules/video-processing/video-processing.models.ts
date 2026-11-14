import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
class ProcessingRenditionDto {
  @ApiProperty() height!: number;
  @ApiProperty() bitrate!: number;
  @ApiProperty({ enum: ["READY"] }) status!: string;
}
export class VideoProcessingResponseDto {
  @ApiProperty({
    enum: ["NOT_REQUESTED", "QUEUED", "PROCESSING", "READY", "FAILED"],
  })
  status!: string;
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 100 })
  progressPercent!: number | null;
  @ApiProperty({ type: [ProcessingRenditionDto] })
  renditions!: ProcessingRenditionDto[];
  @ApiProperty() thumbnailReady!: boolean;
  @ApiPropertyOptional() errorCode?: string;
}
export class VideoRetryResponseDto {
  @ApiProperty({ format: "uuid" }) jobId!: string;
  @ApiProperty({ enum: ["QUEUED"] }) status!: string;
}
