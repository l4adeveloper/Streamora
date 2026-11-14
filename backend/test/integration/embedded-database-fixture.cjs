// Opt-in local PostgreSQL engine for browser tests; never reads application credentials.
const { readFileSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { randomBytes } = require("node:crypto");
async function createEmbeddedTestDatabase() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const db = new PGlite({ extensions: { pg_trgm } });
  const migrations = resolve(__dirname, "../../prisma/migrations");
  for (const name of readdirSync(migrations).sort()) {
    if (name === "migration_lock.toml") continue;
    await db.exec(
      readFileSync(join(migrations, name, "migration.sql"), "utf8"),
    );
  }
  const server = require("node:net").createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port });
  await socket.start();
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const { readEnvironment } = require("../../dist/config/environment");
  const config = readEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: url,
    ACCESS_TOKEN_SECRET: randomBytes(48).toString("hex"),
    FILES_CLEANUP_ENABLED: "false",
    IVS_ENABLED: "false",
  });
  const { PrismaClient } = require("../../dist/generated/prisma/client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 1 }),
  });
  client.onModuleInit = async () => {
    await client.$connect();
    await client.$executeRawUnsafe("SET TIME ZONE 'UTC'");
  };
  client.onModuleDestroy = () => client.$disconnect();
  return {
    url,
    config,
    client,
    async cleanup() {
      await client.$disconnect();
      await socket.stop();
      await db.close();
    },
  };
}
module.exports = { createEmbeddedTestDatabase };
