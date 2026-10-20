const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const {
  HttpException,
  ForbiddenException,
  ServiceUnavailableException,
} = require("@nestjs/common");
const { Prisma } = require("../dist/generated/prisma/client");
const { ApiError, ApiErrorFilter } = require("../dist/common/api-error");
const { createValidationPipe } = require("../dist/common/validation");
const {
  PaginationQueryDto,
} = require("../dist/common/dto/pagination-query.dto");
const { UUIDParamPipe } = require("../dist/common/dto/uuid-param.pipe");
const { RegisterDto } = require("../dist/modules/auth/auth.dto");
const { requestContextMiddleware } = require("../dist/common/http-context");

const PRIVATE = "private-input-must-not-appear";

test("shared DTO validation returns safe field rules without values or unknown property names", async () => {
  const pipe = createValidationPipe();
  await assert.rejects(
    pipe.transform(
      {
        email: "invalid-email",
        password: "secret",
        fullName: "",
        [PRIVATE]: PRIVATE,
      },
      {
        type: "body",
        metatype: RegisterDto,
      },
    ),
    (error) => {
      const body = error.getResponse();
      assert.equal(body.error.code, "VALIDATION_ERROR");
      const fields = body.error.details.fields;
      assert.ok(
        fields.some(
          (issue) => issue.field === "email" && issue.code === "INVALID_EMAIL",
        ),
      );
      assert.ok(
        fields.some(
          (issue) =>
            issue.field === "password" && issue.code === "INVALID_LENGTH",
        ),
      );
      assert.ok(
        fields.some(
          (issue) =>
            issue.field === "_form" && issue.code === "UNEXPECTED_FIELD",
        ),
      );
      assert.ok(!JSON.stringify(body).includes(PRIVATE));
      assert.ok(!JSON.stringify(body).includes('"value"'));
      return true;
    },
  );
});

test("pagination validates bounded integer limits and preserves opaque cursors", async () => {
  const pipe = createValidationPipe();
  const metadata = { type: "query", metatype: PaginationQueryDto };
  assert.equal((await pipe.transform({}, metadata)).limit, 20);
  const valid = await pipe.transform(
    { limit: "100", cursor: "opaque+/==" },
    metadata,
  );
  assert.equal(valid.limit, 100);
  assert.equal(valid.cursor, "opaque+/==");
  for (const limit of ["0", "101", "2.5", "1e2", "0x10", ["20"], "", null]) {
    await assert.rejects(
      pipe.transform({ limit }, metadata),
      (error) => error.getStatus() === 400,
    );
  }
  await assert.rejects(
    pipe.transform({ page: "2" }, metadata),
    (error) => error.getStatus() === 400,
  );
  await assert.rejects(
    pipe.transform({ cursor: "" }, metadata),
    (error) => error.getStatus() === 400,
  );
});

test("the shared UUID pipe rejects arbitrary identifiers without reflecting their value", async () => {
  const pipe = new UUIDParamPipe();
  const id = randomUUID();
  assert.equal(await pipe.transform(id, { type: "param" }), id);
  await assert.rejects(pipe.transform(PRIVATE, { type: "param" }), (error) => {
    assert.equal(
      error.getResponse().error.details.fields[0].code,
      "INVALID_ID",
    );
    assert.ok(!JSON.stringify(error.getResponse()).includes(PRIVATE));
    return true;
  });
});

function filterResponse(error) {
  const headers = {};
  const request = { requestId: randomUUID() };
  const response = {
    headersSent: false,
    setHeader(key, value) {
      headers[key] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
    },
  };
  new ApiErrorFilter().catch(error, {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  });
  assert.equal(headers["X-Request-ID"], response.body.requestId);
  return response;
}

test("HTTP exceptions retain correct status codes while private exception content is hidden", () => {
  for (const [status, code] of [
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [410, "GONE"],
    [413, "PAYLOAD_TOO_LARGE"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
    [429, "RATE_LIMITED"],
    [503, "SERVICE_UNAVAILABLE"],
  ]) {
    const response = filterResponse(
      new HttpException({ message: PRIVATE, password: PRIVATE }, status),
    );
    assert.equal(response.statusCode, status);
    assert.equal(response.body.error.code, code);
    assert.ok(!JSON.stringify(response.body).includes(PRIVATE));
  }
  assert.equal(
    filterResponse(new ForbiddenException(PRIVATE)).body.error.code,
    "FORBIDDEN",
  );
  assert.equal(
    filterResponse(new ServiceUnavailableException(PRIVATE)).statusCode,
    503,
  );
  const unexpected = filterResponse(new Error(PRIVATE));
  assert.equal(unexpected.statusCode, 500);
  assert.equal(unexpected.body.error.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(unexpected.body).includes(PRIVATE));
});

test("business errors keep their explicit code and structured details", () => {
  const details = {
    fields: [{ field: "id", code: "INVALID_ID", message: "ID không hợp lệ." }],
  };
  const response = filterResponse(
    new ApiError(400, "VALIDATION_ERROR", "Dữ liệu sai.", details),
  );
  assert.deepEqual(response.body.error.details, details);
});

test("Prisma errors map to safe conflict/not-found/unavailable responses without database metadata", () => {
  for (const [dbCode, status, apiCode] of [
    ["P2002", 409, "CONFLICT"],
    ["P2025", 404, "NOT_FOUND"],
    ["P2024", 503, "SERVICE_UNAVAILABLE"],
    ["P2034", 409, "CONFLICT"],
  ]) {
    const response = filterResponse(
      new Prisma.PrismaClientKnownRequestError(PRIVATE, {
        code: dbCode,
        clientVersion: "test",
        meta: { password: PRIVATE },
      }),
    );
    assert.equal(response.statusCode, status);
    assert.equal(response.body.error.code, apiCode);
    assert.ok(!JSON.stringify(response.body).includes(PRIVATE));
  }
});

test("request logging uses an allowlist and generates IDs rather than trusting incoming headers", () => {
  const logs = [];
  const request = {
    method: "POST",
    route: { path: "/api/v1/users/:id" },
    headers: {
      authorization: `Bearer ${PRIVATE}`,
      cookie: PRIVATE,
      "x-request-id": PRIVATE,
    },
    body: { password: PRIVATE },
    query: { token: PRIVATE },
    originalUrl: `/private/${PRIVATE}?token=${PRIVATE}`,
  };
  const response = Object.assign(new EventEmitter(), {
    statusCode: 400,
    headersSent: false,
    setHeader() {},
  });
  let called = false;
  requestContextMiddleware((entry) => logs.push(entry))(
    request,
    response,
    () => {
      called = true;
    },
  );
  response.emit("finish");
  assert.ok(called);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].requestId, request.requestId);
  assert.match(logs[0].requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(logs[0]).sort(), [
    "durationMs",
    "event",
    "method",
    "requestId",
    "route",
    "statusCode",
  ]);
  assert.ok(!JSON.stringify(logs).includes(PRIVATE));
  assert.equal(logs[0].route, "/api/v1/users/:id");
  assert.ok(Number.isFinite(logs[0].durationMs));
});

test("unmatched URLs and logger failures do not expose URL data or break requests", () => {
  const logs = [];
  const request = { method: PRIVATE, headers: {}, originalUrl: `/${PRIVATE}` };
  const response = Object.assign(new EventEmitter(), {
    statusCode: 404,
    headersSent: false,
    setHeader() {},
  });
  requestContextMiddleware((entry) => {
    logs.push(entry);
    throw new Error(PRIVATE);
  })(request, response, () => {});
  assert.doesNotThrow(() => response.emit("finish"));
  assert.equal(logs[0].route, "[unmatched]");
  assert.equal(logs[0].method, "OTHER");
  assert.ok(!JSON.stringify(logs).includes(PRIVATE));
});
