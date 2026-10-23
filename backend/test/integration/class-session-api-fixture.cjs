const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { NestFactory } = require("@nestjs/core");
const { Module } = require("@nestjs/common");
const { AppModule } = require("../../dist/modules/app.module");
const { configureApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const {
  AccessTokenService,
} = require("../../dist/modules/auth/access-token.service");
const { createTestDatabase } = require("./database-fixture.cjs");

function expect(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body.error.code, code);
  return result.body;
}
async function createClassSessionApiFixture(options = {}) {
  let database, prisma, app, second;
  const cleanup = async () => {
    try {
      if (app) await app.close();
      if (second) await second.close();
      if (prisma) await prisma.onModuleDestroy();
    } finally {
      if (database) await database.cleanup();
    }
  };
  try {
    database = await createTestDatabase();
    prisma = new PrismaService(database.url);
    await prisma.onModuleInit();
    const origin = "http://127.0.0.1:3000";
    const config = {
      ...database.config,
      databaseUrl: database.url,
      nodeEnv: "test",
      docsEnabled: true,
      webOrigin: origin,
      ...(options.sessionRealtime
        ? { sessionRealtime: options.sessionRealtime }
        : {}),
      auth: {
        ...database.config.auth,
        accessTokenSecret: randomBytes(48).toString("base64url"),
      },
    };
    const boot = async () => {
      let root = AppModule.forRoot(config);
      if (options.imports?.length) {
        class TestRoot {}
        Module({ imports: [root, ...options.imports] })(TestRoot);
        root = TestRoot;
      }
      const server = await NestFactory.create(root, {
        logger: false,
      });
      configureApplication(server, config, { requestLog: () => {} });
      await server.listen(0, "127.0.0.1");
      return server;
    };
    app = await boot();
    second = await boot();
    const base = await app.getUrl(),
      otherBase = await second.getUrl();
    const api = async (
      actor,
      method,
      path,
      body,
      { key, target = base } = {},
    ) => {
      const response = await fetch(`${target}/api/v1${path}`, {
        method,
        headers: {
          Origin: origin,
          ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(key !== undefined ? { "Idempotency-Key": key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
        headers: response.headers,
      };
    };
    const issue = async (user) => {
      const auth = await prisma.authSession.create({
        data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) },
      });
      return {
        ...user,
        authSessionId: auth.id,
        token: app
          .get(AccessTokenService)
          .issue(user.id, auth.id, 900, new Date()),
      };
    };
    const account = async (name) =>
      issue(
        await prisma.user.create({
          data: {
            email: `admission-${name}-${randomUUID()}@example.test`,
            fullName: name,
            passwordHash: "$argon2id$non-loginable-api-fixture",
            globalRole: name === "admin" ? "ADMIN" : "USER",
          },
        }),
      );
    const [owner, host, viewer, viewer2, outsider, admin] = await Promise.all(
      ["owner", "host", "viewer", "viewer2", "outsider", "admin"].map(account),
    );
    const group = () =>
      prisma.group.create({
        data: {
          name: `Admission ${randomUUID()}`,
          ownerId: owner.id,
          members: {
            create: [
              { userId: owner.id, role: "OWNER" },
              { userId: host.id, role: "HOST" },
              { userId: viewer.id, role: "VIEWER" },
              { userId: viewer2.id, role: "VIEWER" },
            ],
          },
        },
      });
    const lesson = async ({ live = true } = {}) => {
      const g = await group();
      const session = expect(
        await api(owner, "POST", `/groups/${g.id}/sessions`, {
          title: "Admission class",
          scheduledAt: "2026-10-25T12:00:00Z",
        }),
        201,
      ).session;
      if (live)
        expect(
          await api(owner, "POST", `/sessions/${session.id}/start`, {}),
          200,
        );
      return { ...session, groupId: g.id };
    };
    const meet = async () => {
      const session = expect(
        await api(owner, "POST", "/meets", { title: "Admission meet" }),
        201,
      ).session;
      expect(
        await api(owner, "POST", `/sessions/${session.id}/start`, {}),
        200,
      );
      return session;
    };
    return {
      prisma,
      api,
      issue,
      account,
      group,
      lesson,
      meet,
      owner,
      host,
      viewer,
      viewer2,
      outsider,
      admin,
      base,
      otherBase,
      app,
      second,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
module.exports = { createClassSessionApiFixture, expect };
