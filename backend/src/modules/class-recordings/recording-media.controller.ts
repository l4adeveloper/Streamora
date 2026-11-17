import {
  Controller,
  Get,
  Head,
  Header,
  Param,
  Req,
  StreamableFile,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { UUIDParamPipe } from "../../common";
import { RecordingSourceService } from "./recording-source.service";

// Playlists use a short-lived HttpOnly scoped grant; the service additionally
// rechecks the viewer's current membership and the published version per request.
@Controller("recording-media/:recordingId/:jobId/:sourceId")
@ApiExcludeController()
export class RecordingMediaController {
  constructor(private readonly sources: RecordingSourceService) {}
  @Get("*path")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  async get(
    @Param("recordingId", UUIDParamPipe) recordingId: string,
    @Param("jobId", UUIDParamPipe) jobId: string,
    @Param("sourceId") sourceId: string,
    @Param("path") path: string[],
    @Req() request: Request,
  ) {
    return new StreamableFile(
      Buffer.from(
        await this.sources.playlist(
          recordingId,
          jobId,
          sourceId,
          path,
          request.cookies?.recording_grant,
        ),
      ),
      { type: "application/vnd.apple.mpegurl" },
    );
  }
  @Head("*path")
  @Header("Cache-Control", "private, no-store")
  async head(
    @Param("recordingId", UUIDParamPipe) recordingId: string,
    @Param("jobId", UUIDParamPipe) jobId: string,
    @Param("sourceId") sourceId: string,
    @Param("path") path: string[],
    @Req() request: Request,
  ) {
    await this.sources.playlist(
      recordingId,
      jobId,
      sourceId,
      path,
      request.cookies?.recording_grant,
    );
    return new StreamableFile(Buffer.alloc(0), {
      type: "application/vnd.apple.mpegurl",
    });
  }
}
