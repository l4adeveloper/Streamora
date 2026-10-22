import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { EmailField } from "../../common/dto/validation.decorators";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import type { AssignableRole } from "@streamora/contracts";

export class UserLookupQueryDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  groupId!: string;
  @ApiProperty({
    format: "email",
    description: "Email chính xác, trim/lowercase.",
  })
  @EmailField()
  email!: string;
}
export class MemberListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    maxLength: 254,
    description: "Tìm theo tên hoặc email trong nhóm.",
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(254)
  q?: string;
}
export class ChangeMemberRoleDto {
  @ApiProperty({ enum: ["HOST", "VIEWER"] })
  @IsIn(["HOST", "VIEWER"])
  role!: AssignableRole;
}
export class AddMemberDto extends ChangeMemberRoleDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  userId!: string;
}
