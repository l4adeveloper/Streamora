const { resolve } = require("node:path");
const { readFile, writeFile } = require("node:fs/promises");
const { isDeepStrictEqual } = require("node:util");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../dist/modules/app.module");
const { readEnvironment } = require("../dist/config/environment");
const { API_PREFIX } = require("../dist/config/auth-policy");
const {
  createMembershipsDocument,
} = require("../dist/documentation/memberships-openapi");

async function exportMembershipsOpenApi({ check = false } = {}) {
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
    const document = createMembershipsDocument(app);
    const output = resolve(__dirname, "../docs/memberships-openapi.json");
    if (check) {
      const saved = await readFile(output, "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      if (!isDeepStrictEqual(saved, JSON.parse(JSON.stringify(document))))
        throw new Error("Chạy npm run docs:t03 để cập nhật hợp đồng T03.");
    } else await writeFile(output, JSON.stringify(document, null, 2) + "\n");
    return document;
  } finally {
    await app.close();
  }
}
if (require.main === module)
  exportMembershipsOpenApi({ check: process.argv.includes("--check") }).catch(
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
module.exports = { exportMembershipsOpenApi };
