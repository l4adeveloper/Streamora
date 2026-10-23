import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { MembershipsModule } from "../modules/memberships/memberships.module";
import { API_PREFIX } from "../config/auth-policy";

export function createMembershipsDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("Streamora T03 — thành viên và quyền nhóm")
    .setVersion("1.0.0")
    .setDescription(
      "T03-01 đến T03-06. T03-07: membership.changed tại namespace /classroom, chỉ tới user bị tác động; reconnect đọc permissions/me. Email thành viên hiển thị theo yêu cầu giao diện.",
    )
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "accessToken",
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    include: [MembershipsModule],
    operationIdFactory: (controller, method) =>
      `${controller.replace(/Controller$/, "").toLowerCase()}_${method}`,
  });
  for (const name of ["AddMemberDto", "ChangeMemberRoleDto"]) {
    const schema = document.components?.schemas?.[name];
    if (schema && !("$ref" in schema)) schema.additionalProperties = false;
  }
  return document;
}
export function setupMembershipsOpenApi(app: INestApplication) {
  SwaggerModule.setup(
    `/${API_PREFIX}/docs-memberships`,
    app,
    () => createMembershipsDocument(app),
    {
      jsonDocumentUrl: `/${API_PREFIX}/docs-memberships-json`,
      raw: ["json"],
      customSiteTitle: "Streamora T03 API",
      swaggerOptions: {
        persistAuthorization: false,
        validatorUrl: null,
        queryConfigEnabled: false,
      },
    },
  );
}
