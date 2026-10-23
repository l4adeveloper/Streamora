import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ClassSessionsModule } from "../modules/class-sessions/class-sessions.module";
import { API_PREFIX } from "../config/auth-policy";

export function createClassSessionsDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("Streamora T04 — lịch học và vòng đời buổi học")
    .setVersion("1.1.0")
    .setDescription(
      "Lịch học/meet và vòng đời; hàng chờ, accept/reject, vào/ra. Bearer và quyền hiện tại do server kiểm tra. Xin/vào yêu cầu Idempotency-Key. Sau enter cần attach Socket.IO /sessions và heartbeat mỗi 10 giây; hết kết nối 30 giây sẽ đóng lượt. Hợp đồng socket xem backend/docs/t04-realtime.md. Không tích hợp LiveKit.",
    )
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "accessToken",
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    include: [ClassSessionsModule],
    operationIdFactory: (controller, method) =>
      `${controller.replace(/Controller$/, "").toLowerCase()}_${method}`,
  });
  for (const name of [
    "CreateGroupClassSessionDto",
    "CreateMeetDto",
    "UpdateClassSessionDto",
    "DecideClassJoinDto",
  ]) {
    const schema = document.components?.schemas?.[name];
    if (schema && !("$ref" in schema)) schema.additionalProperties = false;
  }
  return document;
}
export function setupClassSessionsOpenApi(app: INestApplication) {
  SwaggerModule.setup(
    `/${API_PREFIX}/docs-sessions`,
    app,
    () => createClassSessionsDocument(app),
    {
      jsonDocumentUrl: `/${API_PREFIX}/docs-sessions-json`,
      raw: ["json"],
      customSiteTitle: "Streamora T04 API",
      swaggerOptions: {
        persistAuthorization: false,
        validatorUrl: null,
        queryConfigEnabled: false,
      },
    },
  );
}
