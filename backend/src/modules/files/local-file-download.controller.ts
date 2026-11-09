import {
  Controller,
  Get,
  Head,
  Header,
  Headers,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiExcludeController } from "@nestjs/swagger";
import { FileStorageService } from "./file-storage.service";

// Signed bearer URL, like S3: only download-url issuance requires an access token.
// The browser follows this URL directly, without an Authorization header.
@Controller("file-downloads")
@ApiExcludeController()
export class LocalFileDownloadController {
  constructor(private readonly storage: FileStorageService) {}
  // Register HEAD before GET: Express otherwise handles HEAD through the GET route.
  @Head("local")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @Header("X-Content-Type-Options", "nosniff")
  head(
    @Query("token") token: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.serve(token, response, undefined, true);
  }
  @Get("local")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @Header("X-Content-Type-Options", "nosniff")
  download(
    @Query("token") token: string,
    @Headers("range") range: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.serve(token, response, range);
  }
  private async serve(
    token: string,
    response: Response,
    range?: string,
    head = false,
  ) {
    const file = await this.storage.openLocalDownload(token, range, head);
    const interrupted = () => {
      file.stream.destroy();
    };
    response.once("close", interrupted);
    file.stream.once("close", () => response.off("close", interrupted));
    if (response.destroyed) {
      file.stream.destroy();
      return new StreamableFile(Buffer.alloc(0));
    }
    response.status(file.status);
    response.setHeader("Accept-Ranges", "bytes");
    if (file.contentRange)
      response.setHeader("Content-Range", file.contentRange);
    return new StreamableFile(file.stream, {
      type: file.type,
      disposition: file.disposition,
      length: file.size,
    });
  }
}
