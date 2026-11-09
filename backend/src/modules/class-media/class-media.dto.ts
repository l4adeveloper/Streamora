import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type {
  ClassMediaHeartbeatRequest,
  JoinClassMediaRequest,
} from "@streamora/contracts";
export class JoinClassMediaDto implements JoinClassMediaRequest {
  @ApiProperty({ format: "uuid" }) @IsUUID("4") participationId!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID("4") clientId!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID("4") requestId!: string;
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceLabel?: string;
}
export class ClassMediaHeartbeatDto implements ClassMediaHeartbeatRequest {
  @ApiProperty({ format: "uuid" }) @IsUUID("4") requestId!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID("4") participationId!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID("4") clientId!: string;
  @ApiProperty() @IsBoolean() connected!: boolean;
  @ApiProperty() @IsBoolean() micEnabled!: boolean;
  @ApiProperty() @IsBoolean() cameraEnabled!: boolean;
}
export class JoinClassMediaResponseDto {
  @ApiProperty({ format: "uuid" }) requestId!: string;
  @ApiProperty({ format: "uuid" }) connectionId!: string;
  @ApiProperty({ description: "Opaque IVS token; keep in memory only" })
  participantToken!: string;
  @ApiProperty() participantId!: string;
  @ApiProperty() expiresIn!: number;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
  @ApiProperty({ enum: ["PUBLISH", "SUBSCRIBE"], isArray: true })
  capabilities!: Array<"PUBLISH" | "SUBSCRIBE">;
}
export class ClassMediaAckDto {
  @ApiProperty() ok!: boolean;
}
export class ClassMediaLeaveDto {
  @ApiProperty({ format: "uuid" }) @IsUUID("4") requestId!: string;
}
