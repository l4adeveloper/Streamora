import { ApiProperty } from "@nestjs/swagger";
import type {
  ClassSession,
  ClassSessionStatus,
  ClassSessionKind,
  MeetPreview,
  ClassSessionUser,
} from "@streamora/contracts";
import { SESSION_STATUSES } from "./class-sessions.dto";

export class ClassSessionDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ enum: ["GROUP", "MEET"] }) kind!: ClassSessionKind;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) groupId!:
    string | null;
  @ApiProperty({ format: "uuid" }) createdById!: string;
  @ApiProperty({ maxLength: 100 }) title!: string;
  @ApiProperty({ type: String, nullable: true, maxLength: 2000 }) description!:
    string | null;
  @ApiProperty({ pattern: "^[A-Z0-9]{12}$" }) joinCode!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  scheduledAt!: string | null;
  @ApiProperty({ enum: SESSION_STATUSES }) status!: ClassSessionStatus;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  startedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) endedAt!:
    string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  cancelledAt!: string | null;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiProperty({ format: "date-time" }) updatedAt!: string;
}
export class ClassSessionResponseDto {
  @ApiProperty({ type: ClassSessionDto }) session!: ClassSession;
}
export class ClassSessionListResponseDto {
  @ApiProperty({ type: [ClassSessionDto] }) items!: ClassSession[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ClassSessionUserDto implements ClassSessionUser {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() fullName!: string;
}
export class MeetPreviewDto implements MeetPreview {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: ClassSessionUserDto }) host!: ClassSessionUser;
  @ApiProperty({ enum: SESSION_STATUSES }) status!: ClassSessionStatus;
}
export class MeetPreviewResponseDto {
  @ApiProperty({ type: MeetPreviewDto }) meet!: MeetPreview;
}
