const { resolve } = require("node:path");
const { readFile, writeFile } = require("node:fs/promises");
const { isDeepStrictEqual } = require("node:util");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../dist/modules/app.module");
const { readEnvironment } = require("../dist/config/environment");
const { API_PREFIX } = require("../dist/config/auth-policy");
const { createT01Document } = require("../dist/documentation/openapi");

async function exportOpenApi({ check = false } = {}) {
  // No local env, database connection, HTTP listener or credential is needed.
  // NestFactory.create constructs providers; app.init/listen would connect Prisma.
  const config = readEnvironment({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    DATABASE_URL: "postgresql://documentation:unused@127.0.0.1:1/documentation",
    ACCESS_TOKEN_SECRET: "documentation-only-key-never-used-to-issue-tokens",
  });
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: false,
  });
  try {
    app.setGlobalPrefix(API_PREFIX);
    const document = createT01Document(app);
    const contents = JSON.stringify(document, null, 2) + "\n";
    const output = resolve(__dirname, "../docs/openapi.json");
    if (check) {
      const saved = await readFile(output, "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      if (!isDeepStrictEqual(saved, JSON.parse(contents)))
        throw new Error(
          "OpenAPI đã khác source. Chạy npm run docs:api và cập nhật backend/docs/openapi.json.",
        );
    } else {
      await writeFile(output, contents);
    }
    return document;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  exportOpenApi({ check: process.argv.includes("--check") })
    .then(() =>
      console.log(
        process.argv.includes("--check")
          ? "OpenAPI khớp source."
          : "Đã xuất backend/docs/openapi.json.",
      ),
    )
    .catch((error) => {
      console.error(
        error instanceof Error && error.message.startsWith("OpenAPI đã khác")
          ? error.message
          : "Không xuất/kiểm tra được OpenAPI. Build backend trước khi chạy lại.",
      );
      process.exitCode = 1;
    });
}
module.exports = { exportOpenApi };
