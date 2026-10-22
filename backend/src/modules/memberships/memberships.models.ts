import { ApiProperty } from "@nestjs/swagger";

export class MembershipDto {
  @ApiProperty({ format: "uuid" }) userId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({
    format: "email",
    description: "Hiển thị cho thành viên của nhóm theo yêu cầu giao diện T03.",
  })
  email!: string;
  @ApiProperty({ enum: ["OWNER", "HOST", "VIEWER"] }) role!: string;
  @ApiProperty({ format: "date-time" }) joinedAt!: string;
}
export class MembershipResponseDto {
  @ApiProperty({ type: MembershipDto }) membership!: MembershipDto;
}
export class MembershipListResponseDto {
  @ApiProperty({ type: [MembershipDto] }) items!: MembershipDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class LookupUserDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ format: "email" }) email!: string;
}
export class UserLookupResponseDto {
  @ApiProperty({ type: LookupUserDto, nullable: true })
  user!: LookupUserDto | null;
}
export class GroupPermissionsDto {
  @ApiProperty({ enum: ["ADMIN", "OWNER", "HOST", "VIEWER"] }) role!: string;
  @ApiProperty() canManageMembers!: boolean;
  @ApiProperty() canHost!: boolean;
  @ApiProperty() canUpload!: boolean;
  @ApiProperty() canViewRecordings!: boolean;
}
