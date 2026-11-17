import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Put,
  Query,
  Post,
  HttpCode,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { RecordingSourceService } from "./recording-source.service";
import { applyPlaybackCookies } from "../video-processing/playback-cookies";
import { ApiError } from "../../common/api-error";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentAuth, RequireAuth, UUIDParamPipe } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { RecordingPlaybackService } from "./recording-playback.service";

@Controller("groups/:groupId/recordings")
@ApiTags("Recording playback")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class GroupRecordingsController {
  constructor(private readonly playback: RecordingPlaybackService) {}
  @Get()
  @Header("Cache-Control", "no-store")
  list(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", UUIDParamPipe) groupId: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Query("status") status?: string,
  ) {
    return this.playback.list(
      auth.user.id,
      groupId,
      limit === undefined ? 20 : Number(limit),
      cursor,
      status,
    );
  }
}

@Controller("recordings/:recordingId")
@ApiTags("Recording playback")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class RecordingPlaybackController {
  constructor(
    private readonly playback: RecordingPlaybackService,
    private readonly sources: RecordingSourceService,
  ) {}
  @Post("playback")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async resolve(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("recordingId", UUIDParamPipe) id: string,
    @Body()
    body: {
      mode?: unknown;
      failedSourceId?: unknown;
      preferredSourceId?: unknown;
      positionSeconds?: unknown;
      viewerRegion?: unknown;
    },
    @Res({ passthrough: true }) response: Response,
  ) {
    return applyPlaybackCookies(
      await this.sources.resolve(auth.user.id, id, body),
      response,
    );
  }
  @Get("thumbnail")
  @Header("Cache-Control", "no-store")
  async thumbnail(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("recordingId", UUIDParamPipe) id: string,
  ) {
    const result = await this.sources.resolve(auth.user.id, id, {
      mode: "VOD",
    });
    if (!result.thumbnail)
      throw new ApiError(
        404,
        "THUMBNAIL_NOT_FOUND",
        "Chưa có ảnh đại diện video.",
      );
    return {
      url: result.thumbnail,
      sourceId: result.sourceId,
      authorization: result.authorization,
    };
  }
  @Get()
  @Header("Cache-Control", "no-store")
  detail(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("recordingId", UUIDParamPipe) id: string,
  ) {
    return this.playback.detail(auth.user.id, id);
  }
  @Get("progress")
  @Header("Cache-Control", "no-store")
  progress(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("recordingId", UUIDParamPipe) id: string,
  ) {
    return this.playback.progress(auth.user.id, id);
  }
  @Put("progress")
  @Header("Cache-Control", "no-store")
  save(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("recordingId", UUIDParamPipe) id: string,
    @Body() body: { positionSeconds: number; clientUpdatedAt: string },
  ) {
    return this.playback.saveProgress(
      auth.user.id,
      id,
      body?.positionSeconds,
      body?.clientUpdatedAt,
    );
  }
}
