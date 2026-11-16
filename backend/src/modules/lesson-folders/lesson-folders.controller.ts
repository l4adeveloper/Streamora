import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import {
  CurrentAuth,
  RequireAuth,
  UUIDParamPipe,
  type AuthenticatedIdentity,
} from "../../common";
import { LessonFoldersService } from "./lesson-folders.service";

export class LessonMaterialsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  fileIds!: string[];
}
export class LessonSummaryDto {
  @IsOptional() @IsString() @MaxLength(4000) customPrompt?: string;
}
export class ReadLessonSummaryDto {
  @IsOptional() @IsUUID() summaryId?: string;
}
@Controller("folders/:folderId")
@ApiTags("Lesson folders")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class LessonFoldersController {
  constructor(private readonly lessons: LessonFoldersService) {}
  @Post("materials")
  @HttpCode(200)
  add(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("folderId", UUIDParamPipe) id: string,
    @Body() body: LessonMaterialsDto,
  ) {
    return this.lessons.addMaterials(auth.user.id, id, body.fileIds);
  }
  @Get("summary")
  read(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("folderId", UUIDParamPipe) id: string,
    @Query() query: ReadLessonSummaryDto,
  ) {
    return this.lessons.read(auth.user.id, id, query.summaryId);
  }
  @Post("summary")
  @HttpCode(202)
  request(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("folderId", UUIDParamPipe) id: string,
    @Body() body: LessonSummaryDto,
  ) {
    return this.lessons.request(
      auth.user.id,
      id,
      body.customPrompt?.trim() ?? "",
    );
  }
}
