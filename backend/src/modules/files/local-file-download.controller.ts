import { Controller, Get, Header, Query, StreamableFile } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { FileStorageService } from "./file-storage.service";

// Signed bearer URL, like S3: only download-url issuance requires an access token.
// The browser follows this URL directly, without an Authorization header.
@Controller("file-downloads")
@ApiExcludeController()
export class LocalFileDownloadController {
  constructor(private readonly storage: FileStorageService) {}
  @Get("local")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @Header("X-Content-Type-Options", "nosniff")
  async download(@Query("token") token: string) {
    const file = await this.storage.openLocalDownload(token);
    return new StreamableFile(file.stream, {
      type: file.type,
      disposition: file.disposition,
      length: file.size,
    });
  }
}
