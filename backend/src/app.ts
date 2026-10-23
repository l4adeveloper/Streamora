import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module";
import type { EnvironmentConfig } from "./config/environment";
import { API_PREFIX } from "./config/auth-policy";
import cookieParser from "cookie-parser";
import type { Request, Response, NextFunction } from "express";
import { ApiErrorFilter } from "./common/api-error";
import { createValidationPipe } from "./common/validation";
import { setupOpenApi, DOCS_PATH, OPENAPI_PATH } from "./documentation/openapi";
import { setupMembershipsOpenApi } from "./documentation/memberships-openapi";
import { setupClassSessionsOpenApi } from "./documentation/class-sessions-openapi";
import {
  requestContextMiddleware,
  type RequestLogWriter,
} from "./common/http-context";

export interface ApplicationOptions {
  requestLog?: RequestLogWriter;
}

export async function createApplication(
  config: EnvironmentConfig,
  options: ApplicationOptions = {},
) {
  const app = await NestFactory.create(AppModule.forRoot(config));
  configureApplication(app, config, options);
  return app;
}

export function configureApplication(
  app: INestApplication,
  config: EnvironmentConfig,
  options: ApplicationOptions = {},
) {
  app.use(requestContextMiddleware(options.requestLog));
  app.use(cookieParser());
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (
      request.path.startsWith(`/${API_PREFIX}/auth/`) ||
      request.path === `/${API_PREFIX}/users/me` ||
      request.path === `/${API_PREFIX}/users/lookup` ||
      request.path.startsWith(`/${API_PREFIX}/groups/`) ||
      request.path.startsWith(`/${API_PREFIX}/rooms`) ||
      request.path.startsWith(`/${API_PREFIX}/sessions`) ||
      request.path.startsWith(`/${API_PREFIX}/meets`) ||
      request.path.startsWith(`/${API_PREFIX}/files`) ||
      request.path === OPENAPI_PATH ||
      request.path.startsWith(DOCS_PATH)
    ) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Pragma", "no-cache");
    }
    next();
  });
  app.useGlobalFilters(new ApiErrorFilter());
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => callback(null, origin === config.webOrigin),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    exposedHeaders: ["X-Request-ID", "Retry-After"],
  });
  app.useGlobalPipes(createValidationPipe());
  if (config.docsEnabled) {
    setupOpenApi(app);
    setupMembershipsOpenApi(app);
    setupClassSessionsOpenApi(app);
  }
  app.enableShutdownHooks();
}
