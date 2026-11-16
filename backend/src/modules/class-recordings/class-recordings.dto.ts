import { IsBoolean, IsIn, IsOptional, IsUUID } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type {
  ClassRecordingCameraPosition,
  CompleteClassRecordingRequest,
  StartClassRecordingRequest,
  UpdateClassRecordingLayoutRequest,
} from "@streamora/contracts";

const POSITIONS: ClassRecordingCameraPosition[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export class StartClassRecordingDto implements StartClassRecordingRequest {
  @ApiProperty({ format: "uuid", description: "Lượt tham gia đang mở của người ghi" })
  @IsUUID("4")
  participationId!: string;
}
export class UpdateClassRecordingLayoutDto
  implements UpdateClassRecordingLayoutRequest
{
  @ApiPropertyOptional({ enum: POSITIONS })
  @IsOptional()
  @IsIn(POSITIONS)
  cameraPosition?: ClassRecordingCameraPosition;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  cameraVisible?: boolean;
}
export class CompleteClassRecordingDto implements CompleteClassRecordingRequest {
  @ApiProperty({ format: "uuid", description: "File LOCAL_RECORDING vừa tải lên" })
  @IsUUID("4")
  fileId!: string;
}
class ClassRecordingLayoutModel {
  @ApiProperty({ enum: POSITIONS }) cameraPosition!: ClassRecordingCameraPosition;
  @ApiProperty() cameraVisible!: boolean;
}
class ClassRecordingPresenterModel {
  @ApiProperty({ format: "uuid" }) userId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, nullable: true }) participantId!: string | null;
}
export class ClassRecordingModel {
  @ApiPropertyOptional() starting?: boolean;
  @ApiPropertyOptional() errorCode?: string;
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) sessionId!: string;
  @ApiProperty({ enum: ["RECORDING", "SAVING", "SAVED", "FAILED"] }) status!: string;
  @ApiProperty({ format: "uuid" }) recorderId!: string;
  @ApiProperty() recorderName!: string;
  @ApiProperty({ format: "date-time" }) startedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) stoppedAt!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) fileId!: string | null;
  @ApiProperty({ type: ClassRecordingLayoutModel }) layout!: ClassRecordingLayoutModel;
  @ApiProperty({ type: ClassRecordingPresenterModel, nullable: true })
  presenter!: ClassRecordingPresenterModel | null;
  @ApiProperty() version!: number;
}
export class ClassRecordingResponseDto {
  @ApiProperty({ type: ClassRecordingModel }) recording!: ClassRecordingModel;
}
export class ClassRecordingStateDto {
  @ApiProperty({ type: ClassRecordingModel, nullable: true })
  recording!: ClassRecordingModel | null;
  @ApiProperty() canRecord!: boolean;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) groupId!: string | null;
  @ApiProperty() title!: string;
}
