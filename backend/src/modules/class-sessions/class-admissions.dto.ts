import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, ValidateIf } from "class-validator";
import type {
  ClassJoinRequestStatus,
  DecideClassJoinRequest,
  ClassJoinRequestListRequest,
} from "@streamora/contracts";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export const JOIN_REQUEST_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "REVOKED",
] as const;

export class DecideClassJoinDto implements DecideClassJoinRequest {
  @ApiProperty({ enum: ["ACCEPT", "REJECT"] })
  @IsIn(["ACCEPT", "REJECT"])
  decision!: "ACCEPT" | "REJECT";
}

export class ClassJoinRequestListQueryDto
  extends PaginationQueryDto
  implements ClassJoinRequestListRequest
{
  @ApiPropertyOptional({ enum: JOIN_REQUEST_STATUSES, default: "PENDING" })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(JOIN_REQUEST_STATUSES)
  status: ClassJoinRequestStatus = "PENDING";
}
