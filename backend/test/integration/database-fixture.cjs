const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolve, dirname } = require("node:path");
const { Client } = require("pg");
const {
  loadEnvironmentFile,
  readEnvironment,
} = require("../../dist/config/environment");

const execute = promisify(execFile);

async function createTestDatabase() {
  loadEnvironmentFile();
  const config = readEnvironment();
  const name = `streamora_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  await admin.connect();
  let created = false;
  const cleanup = async () => {
    try {
      // Only drop the exact database created by this fixture, never the app DB.
      if (created && /^streamora_test_[a-f0-9]{32}$/.test(name)) {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        created = false;
      }
    } finally {
      await admin.end();
    }
  };

  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(config.databaseUrl);
    url.pathname = `/${name}`;
    const cliPath = resolve(
      dirname(require.resolve("prisma/package.json")),
      require("prisma/package.json").bin.prisma,
    );
    await execute(process.execPath, [cliPath, "migrate", "deploy"], {
      cwd: resolve(__dirname, "../.."),
      env: { ...process.env, DATABASE_URL: url.toString() },
      timeout: 90000,
    });
    return { url: url.toString(), config, cleanup };
  } catch {
    await cleanup();
    throw new Error(
      "Không tạo được database kiểm thử hoặc chạy migration. Kiểm tra kết nối PostgreSQL và quyền CREATEDB của user trong DATABASE_URL.",
    );
  }
}

module.exports = { createTestDatabase };
