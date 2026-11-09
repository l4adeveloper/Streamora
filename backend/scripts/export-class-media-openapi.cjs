const { resolve } = require("node:path");
const { readFile, writeFile } = require("node:fs/promises");
const { isDeepStrictEqual } = require("node:util");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../dist/modules/app.module");
const { readEnvironment } = require("../dist/config/environment");
const {
  createClassMediaDocument,
} = require("../dist/documentation/class-media-openapi");
async function exportClassMediaOpenApi({ check = false } = {}) {
  const config = readEnvironment({
    NODE_ENV: "test",
    ACCESS_TOKEN_SECRET: "documentation-only-secret-never-used-for-live-tokens",
    DATABASE_URL: "postgresql://documentation:unused@127.0.0.1:1/documentation",
  });
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: false,
  });
  try {
    app.setGlobalPrefix("api/v1");
    const document = JSON.parse(JSON.stringify(createClassMediaDocument(app)));
    const path = resolve(__dirname, "../docs/class-media-openapi.json");
    if (check) {
      const saved = JSON.parse(await readFile(path, "utf8"));
      if (!isDeepStrictEqual(saved, document))
        throw new Error("Chạy npm run docs:t05 để cập nhật hợp đồng media.");
    } else await writeFile(path, JSON.stringify(document, null, 2) + "\n");
    return document;
  } finally {
    await app.close();
  }
}
module.exports = { exportClassMediaOpenApi };
if (require.main === module)
  void exportClassMediaOpenApi({
    check: process.argv.includes("--check"),
  }).catch(() => {
    console.error("Không thể xuất/kiểm tra OpenAPI T05.");
    process.exitCode = 1;
  });
