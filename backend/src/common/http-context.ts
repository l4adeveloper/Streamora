import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Request, Response, NextFunction } from "express";

export interface ApiRequest extends Request {
  requestId?: string;
}
export interface RequestLogEntry {
  event: "http_request";
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}
export type RequestLogWriter = (entry: RequestLogEntry) => void;

export function requestId(request: ApiRequest, response: Response): string {
  if (!request.requestId) request.requestId = randomUUID();
  if (!response.headersSent)
    response.setHeader("X-Request-ID", request.requestId);
  return request.requestId;
}

export function requestContextMiddleware(
  write: RequestLogWriter = (entry) => console.info(JSON.stringify(entry)),
) {
  return (request: ApiRequest, response: Response, next: NextFunction) => {
    // Always generate locally. Never echo an arbitrary incoming ID into logs.
    request.requestId = randomUUID();
    const id = requestId(request, response);
    const start = performance.now();
    response.once("finish", () => {
      const route: unknown = request.route?.path;
      const entry: RequestLogEntry = {
        event: "http_request",
        requestId: id,
        method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(
          request.method,
        )
          ? request.method
          : "OTHER",
        route: typeof route === "string" ? route : "[unmatched]",
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      };
      // Only this allowlisted metadata is sent to the sink. No request/exception objects.
      try {
        write(entry);
      } catch {
        /* Logging must never break an HTTP response. */
      }
    });
    next();
  };
}
