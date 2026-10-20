import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { API_PREFIX, AUTH_POLICY } from "../config/auth-policy";
import { AuthModule } from "../modules/auth/auth.module";
import { UsersModule } from "../modules/users/users.module";

export const DOCS_PATH = `/${API_PREFIX}/docs`;
export const OPENAPI_PATH = `/${API_PREFIX}/docs-json`;

export function createT01Document(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("Streamora T01 — tài khoản và phiên")
    .setVersion("1.0.0")
    .setDescription(
      "Sáu API T01. Access token giữ trong bộ nhớ; refresh cookie HttpOnly xoay vòng, hạn tuyệt đối, reuse thu hồi family. POST auth yêu cầu Origin=WEB_ORIGIN. Swagger trên host API chỉ cho Try it out GET/PATCH bằng Bearer; thử POST auth qua frontend hoặc hướng dẫn PowerShell. Swagger không tự refresh phiên.",
    )
    .addServer("/", "Host API đang phục vụ tài liệu; paths đã bao gồm /api/v1.")
    .addTag("Auth", "Đăng ký, đăng nhập và quản lý refresh session.")
    .addTag("Users", "Hồ sơ của user đã xác thực.")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Access token từ login/refresh. Không dán refresh token.",
      },
      "accessToken",
    )
    .addCookieAuth(
      AUTH_POLICY.refreshCookieName,
      {
        type: "apiKey",
        in: "cookie",
        description:
          "Cookie HttpOnly do browser quản lý; không nhập/lưu token này vào Swagger.",
      },
      "refreshCookie",
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    include: [AuthModule, UsersModule],
    deepScanRoutes: false,
    operationIdFactory: (controller, method) =>
      `${controller.replace(/Controller$/, "").toLowerCase()}_${method}`,
  });
  // Unknown @Body() parameters have no DTO. These endpoints use the cookie only.
  for (const action of ["refresh", "logout"]) {
    const operation = document.paths[`/${API_PREFIX}/auth/${action}`]?.post;
    if (operation) delete operation.requestBody;
  }
  // All request DTOs use whitelist + forbidNonWhitelisted at runtime.
  for (const name of ["RegisterDto", "LoginDto", "UpdateProfileDto"]) {
    const schema = document.components?.schemas?.[name];
    if (schema && !("$ref" in schema)) schema.additionalProperties = false;
  }
  return document;
}

export function setupOpenApi(app: INestApplication) {
  SwaggerModule.setup(DOCS_PATH, app, () => createT01Document(app), {
    jsonDocumentUrl: OPENAPI_PATH,
    swaggerUrl: OPENAPI_PATH,
    raw: ["json"],
    customSiteTitle: "Streamora T01 API",
    swaggerOptions: {
      persistAuthorization: false,
      validatorUrl: null,
      queryConfigEnabled: false,
      supportedSubmitMethods: ["get", "patch"],
      withCredentials: false,
      docExpansion: "list",
      defaultModelsExpandDepth: 0,
      displayRequestDuration: true,
    },
  });
}
