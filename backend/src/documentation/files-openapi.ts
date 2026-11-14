import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { FilesModule } from "../modules/files/files.module";
import { UploadsModule } from "../modules/uploads/uploads.module";
import { VideoProcessingModule } from "../modules/video-processing/video-processing.module";
import { API_PREFIX } from "../config/auth-policy";
export function createFilesDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("Streamora T15/T16/T17 — thư viện, upload multipart và resume")
    .setVersion("1.0.0")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "accessToken",
    )
    .build();
  return SwaggerModule.createDocument(app, config, {
    include: [FilesModule, UploadsModule, VideoProcessingModule],
  });
}
export function setupFilesOpenApi(app: INestApplication) {
  SwaggerModule.setup(
    `/${API_PREFIX}/docs-files`,
    app,
    () => createFilesDocument(app),
    {
      jsonDocumentUrl: `/${API_PREFIX}/docs-files-json`,
      raw: ["json"],
      swaggerOptions: {
        persistAuthorization: false,
        validatorUrl: null,
        supportedSubmitMethods: ["get", "post", "patch", "delete"],
      },
    },
  );
}
