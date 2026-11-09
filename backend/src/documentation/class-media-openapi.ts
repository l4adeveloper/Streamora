import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ClassMediaModule } from "../modules/class-media/class-media.module";
export function createClassMediaDocument(app: INestApplication) {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Streamora T05 — mic, camera và IVS")
      .setVersion("1.0.0")
      .addBearerAuth(
        { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        "accessToken",
      )
      .build(),
    { include: [ClassMediaModule] },
  );
  for (const name of [
    "JoinClassMediaDto",
    "ClassMediaHeartbeatDto",
    "ClassMediaLeaveDto",
  ]) {
    const schema = document.components?.schemas?.[name];
    if (schema && !("$ref" in schema)) schema.additionalProperties = false;
  }
  return document;
}
export function setupClassMediaOpenApi(app: INestApplication) {
  SwaggerModule.setup(
    "/api/v1/docs-media",
    app,
    () => createClassMediaDocument(app),
    {
      jsonDocumentUrl: "/api/v1/docs-media-json",
      swaggerOptions: { persistAuthorization: false, validatorUrl: null },
    },
  );
}
