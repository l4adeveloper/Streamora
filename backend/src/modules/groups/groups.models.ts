import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { Group, GroupMember, GroupMemberRole, CursorPage } from "@streamora/contracts";

export class GroupDto implements Group {
  @ApiProperty({ format: "uuid", example: "c0fe1234-dc39-4c7e-8652-c30e9fc4135e" })
  id!: string;

  @ApiProperty({ example: "Nhóm Điện toán đám mây K69" })
  name!: string;

  @ApiPropertyOptional({ example: "Nhóm học tập môn Điện toán đám mây — K69 UET." })
  description!: string | null;

  @ApiProperty({ format: "uuid", description: "ID người tạo (owner)." })
  ownerId!: string;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;
}

export class GroupResponseDto {
  @ApiProperty({ type: GroupDto })
  group!: GroupDto;
}

export class GroupMemberDto implements GroupMember {
  @ApiProperty({ format: "uuid" })
  userId!: string;

  @ApiProperty({ format: "uuid" })
  groupId!: string;

  @ApiProperty({ enum: ["OWNER", "HOST", "VIEWER"], enumName: "GroupMemberRole" })
  role!: GroupMemberRole;

  @ApiProperty({ format: "date-time" })
  joinedAt!: string;
}

export class GroupListResponseDto implements CursorPage<Group> {
  @ApiProperty({ type: [GroupDto] })
  items!: GroupDto[];

  @ApiPropertyOptional({ type: String, nullable: true })
  nextCursor!: string | null;
}
