import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ClassSessionsModule } from "../modules/class-sessions/class-sessions.module";
import { ClassModerationModule } from "../modules/class-moderation/class-moderation.module";
import { PollsModule } from "../modules/polls/polls.module";
import { API_PREFIX } from "../config/auth-policy";

export function createClassSessionsDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("Streamora — buổi học và quản lý phòng")
    .setVersion("1.1.0")
    .setDescription(
      "Lịch học, vòng đời, xét duyệt vào phòng và quản lý người tham gia. Bearer và quyền hiện tại do server kiểm tra. Xin/vào yêu cầu Idempotency-Key. Sau enter cần attach Socket.IO /classroom và heartbeat mỗi 10 giây. Hợp đồng socket xem backend/docs/t04-realtime.md. Media thuộc T05.",
    )
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "accessToken",
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    include: [ClassSessionsModule, ClassModerationModule, PollsModule],
    operationIdFactory: (controller, method) =>
      `${controller.replace(/Controller$/, "").toLowerCase()}_${method}`,
  });
  for (const name of [
    "CreateGroupClassSessionDto",
    "CreateMeetDto",
    "UpdateClassSessionDto",
    "DecideClassJoinDto",
    "ClassMuteDto",
    "ClassBanDto",
    "CreatePollDto",
    "PollOptionInput",
    "VotePollDto",
    "ClosePollDto",
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
      customSiteTitle: "Streamora Class Sessions API",
      swaggerOptions: {
        persistAuthorization: false,
        validatorUrl: null,
        queryConfigEnabled: false,
      },
    },
  );
}
