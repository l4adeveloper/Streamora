import { ApiProperty } from "@nestjs/swagger";
import type {
  ClassAdmissionResponse,
  ClassJoinRequest,
  ClassJoinRequestStatus,
  ClassParticipation,
  ClassParticipationLeaveReason,
  ClassSessionPermissions,
  ClassJoinRequestWithUser,
  ClassParticipationWithUser,
} from "@streamora/contracts";
import { ClassSessionUserDto } from "./class-sessions.models";
import { JOIN_REQUEST_STATUSES } from "./class-admissions.dto";

export class ClassJoinRequestDto implements ClassJoinRequest {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) sessionId!: string;
  @ApiProperty({ format: "uuid" }) userId!: string;
  @ApiProperty({ enum: JOIN_REQUEST_STATUSES }) status!: ClassJoinRequestStatus;
  @ApiProperty({ format: "date-time" }) requestedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  decidedAt!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) decidedById!:
    string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  closedAt!: string | null;
}
export class ClassParticipationDto implements ClassParticipation {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) sessionId!: string;
  @ApiProperty({ format: "uuid" }) userId!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  joinRequestId!: string | null;
  @ApiProperty({ format: "date-time" }) joinedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) leftAt!:
    string | null;
  @ApiProperty({
    type: String,
    enum: ["LEFT", "DISCONNECTED", "SESSION_ENDED", "ACCESS_REVOKED"],
    nullable: true,
  })
  leaveReason!: ClassParticipationLeaveReason | null;
}
export class ClassJoinRequestWithUserDto extends ClassJoinRequestDto {
  @ApiProperty({ type: ClassSessionUserDto }) user!: ClassSessionUserDto;
}
export class ClassParticipationWithUserDto extends ClassParticipationDto {
  @ApiProperty({ type: ClassSessionUserDto }) user!: ClassSessionUserDto;
}
export class ClassJoinRequestResponseDto {
  @ApiProperty({ type: ClassJoinRequestDto }) request!: ClassJoinRequest;
}
export class ClassJoinRequestListResponseDto {
  @ApiProperty({ type: [ClassJoinRequestWithUserDto] })
  items!: ClassJoinRequestWithUser[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ClassParticipationResponseDto {
  @ApiProperty({ type: ClassParticipationDto })
  participation!: ClassParticipation;
}
export class ClassParticipationListResponseDto {
  @ApiProperty({ type: [ClassParticipationWithUserDto] })
  items!: ClassParticipationWithUser[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ClassSessionPermissionsDto implements ClassSessionPermissions {
  @ApiProperty() canManage!: boolean;
  @ApiProperty() canRequestJoin!: boolean;
  @ApiProperty() canEnter!: boolean;
  @ApiProperty() canViewParticipants!: boolean;
}
export class ClassAdmissionResponseDto implements ClassAdmissionResponse {
  @ApiProperty({ type: ClassJoinRequestDto, nullable: true })
  request!: ClassJoinRequest | null;
  @ApiProperty({ type: ClassParticipationDto, nullable: true })
  participation!: ClassParticipation | null;
  @ApiProperty({ type: ClassSessionPermissionsDto })
  permissions!: ClassSessionPermissions;
}
