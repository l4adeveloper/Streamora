import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { CLASS_POLL_LIMITS as limits } from "@streamora/contracts";
import type {
  ClassPoll,
  ClassPollOption,
  ClassPollResponse,
  ClassPollStatus,
  ClassPollVoteRequest,
  CreateClassPollRequest,
} from "@streamora/contracts";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

class PollOptionInput {
  @ApiProperty({ minLength: 1, maxLength: limits.maxOptionLength })
  @Transform(trim)
  @IsString()
  @Length(1, limits.maxOptionLength)
  text!: string;
}

export class CreatePollDto implements CreateClassPollRequest {
  @ApiProperty({ minLength: 1, maxLength: limits.maxQuestionLength })
  @Transform(trim)
  @IsString()
  @Length(1, limits.maxQuestionLength)
  question!: string;

  @ApiProperty({
    type: [PollOptionInput],
    minItems: limits.minOptions,
    maxItems: limits.maxOptions,
  })
  @IsArray()
  @ArrayMinSize(limits.minOptions)
  @ArrayMaxSize(limits.maxOptions)
  @ValidateNested({ each: true })
  @Type(() => PollOptionInput)
  options!: PollOptionInput[];
}

export class VotePollDto implements ClassPollVoteRequest {
  @ApiProperty({ format: "uuid" })
  @IsUUID("4")
  optionId!: string;
}

export class ClosePollDto {}

class PollOptionDto implements ClassPollOption {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() text!: string;
  @ApiProperty({ type: "integer" }) count!: number;
}

class PollDto implements ClassPoll {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) sessionId!: string;
  @ApiProperty() question!: string;
  @ApiProperty({ type: [PollOptionDto] }) options!: ClassPollOption[];
  @ApiProperty({ enum: ["OPEN", "CLOSED"] }) status!: ClassPollStatus;
  @ApiProperty({ type: "integer" }) totalVotes!: number;
  @ApiProperty({ pattern: "^\\d+$" }) version!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) myOptionId!:
    string | null;
}

export class PollResponseDto implements ClassPollResponse {
  @ApiProperty({ type: PollDto }) poll!: ClassPoll;
}

export class PollListDto {
  @ApiProperty({ type: [PollDto] }) items!: ClassPoll[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
