// Isolated PostgreSQL-compatible database; never reads the application's .env.
const { randomBytes, randomUUID } = require("node:crypto");
const { readFileSync, readdirSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join, dirname, basename } = require("node:path");
const { createServer } = require("node:net");

async function createMeetingFixture(webOrigin = "http://127.0.0.1:3000") {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const { NestFactory } = require("@nestjs/core");
  const { AppModule } = require("../dist/modules/app.module");
  const { configureApplication } = require("../dist/app");
  const { readEnvironment } = require("../dist/config/environment");
  const { PrismaService } = require("../dist/database/prisma.service");
  const {
    AccessTokenService,
  } = require("../dist/modules/auth/access-token.service");
  const db = new PGlite({ extensions: { pg_trgm } });
  const migrations = resolve(__dirname, "../prisma/migrations");
  for (const item of readdirSync(migrations, { withFileTypes: true })
    .filter((x) => x.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)))
    await db.exec(
      readFileSync(join(migrations, item.name, "migration.sql"), "utf8"),
    );
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const socket = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port,
    maxConnections: 50,
  });
  await socket.start();
  const directory = mkdtempSync(join(tmpdir(), "streamora-meeting-"));
  const config = readEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    ACCESS_TOKEN_SECRET: randomBytes(48).toString("hex"),
    WEB_ORIGIN: webOrigin,
    FILES_LOCAL_DIRECTORY: directory,
    FILES_CLEANUP_ENABLED: "false",
    IVS_ENABLED: "false",
  });
  // PGlite has one database connection. Keep the test adapter serialized so
  // PostgreSQL wire messages from concurrent browser reads cannot interleave.
  const { PrismaClient } = require("../dist/generated/prisma/client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 1 }),
  });
  client.onModuleInit = () => client.$connect();
  client.onModuleDestroy = () => client.$disconnect();
  const root = AppModule.forRoot(config);
  const databaseModule = root.imports.find((module) =>
    module.providers?.includes(PrismaService),
  );
  databaseModule.providers = databaseModule.providers.map((provider) =>
    provider === PrismaService
      ? { provide: PrismaService, useValue: client }
      : provider,
  );
  const app = await NestFactory.create(root, { logger: false });
  configureApplication(app, config, { requestLog: () => {} });
  await app.listen(0, "127.0.0.1");
  const prisma = app.get(PrismaService);
  const base = `${await app.getUrl()}/api/v1`;
  const account = async (name, globalRole = "USER") => {
    const user = await prisma.user.create({
      data: {
        email: `meeting-${randomUUID()}@example.test`,
        fullName: name,
        passwordHash: "$argon2id$fixture",
        globalRole,
      },
    });
    const auth = await prisma.authSession.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) },
    });
    const token = app
      .get(AccessTokenService)
      .issue(user.id, auth.id, 900, new Date());
    return { ...user, token };
  };
  const api = async (actor, method, path, body, key) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: webOrigin,
        ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  };
  return {
    app,
    prisma,
    account,
    api,
    base,
    config,
    async cleanup() {
      await app.close();
      await socket.stop();
      await db.close();
      if (
        dirname(directory) !== resolve(tmpdir()) ||
        !/^streamora-meeting-/.test(basename(directory))
      )
        throw new Error("Invalid meeting test cleanup path");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
module.exports = { createMeetingFixture };
