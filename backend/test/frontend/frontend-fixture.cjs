const { createServer } = require("node:http");
const { randomUUID, randomBytes } = require("node:crypto");
const { cp, copyFile, mkdir, rm, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { join, resolve, dirname, basename, relative } = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../../dist/modules/app.module");
const { configureApplication } = require("../../dist/app");
const { PrismaService } = require("../../dist/database/prisma.service");
const { createTestDatabase } = require("../integration/database-fixture.cjs");
const jwt = require("jsonwebtoken");

const root = resolve(__dirname, "../../..");
const execute = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function createFrontendFixture({
  sessionProbe = false,
  shellProbe = false,
} = {}) {
  const previewRoot = join(root, ".preview");
  const directory = join(previewRoot, `auth-frontend-run-${randomUUID()}`);
  const webRoot = join(directory, "web");
  let database, prisma, app, server;
  const cleanup = async () => {
    try {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit");
        server.kill();
        await exited;
      }
      if (app) await app.close();
      if (prisma) await prisma.onModuleDestroy();
    } finally {
      try {
        if (database) await database.cleanup();
      } finally {
        if (
          dirname(directory) !== previewRoot ||
          !/^auth-frontend-run-[a-f0-9-]{36}$/.test(basename(directory))
        )
          throw new Error("Đường dẫn frontend test không hợp lệ.");
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    const port = await freePort();
    const webOrigin = `http://127.0.0.1:${port}`;
    database = await createTestDatabase();
    prisma = new PrismaService(database.url);
    await prisma.onModuleInit();
    const config = {
      ...database.config,
      databaseUrl: database.url,
      webOrigin,
      nodeEnv: "test",
      auth: {
        ...database.config.auth,
        accessTokenSecret: randomBytes(48).toString("base64url"),
        cookie: {
          ...database.config.auth.cookie,
          secure: false,
          sameSite: "lax",
        },
      },
    };
    app = await NestFactory.create(AppModule.forRoot(config), {
      logger: false,
    });
    configureApplication(app, config, { requestLog: () => {} });
    await app.listen(0, "127.0.0.1");
    const apiUrl = `${await app.getUrl()}/api/v1`;
    await mkdir(webRoot, { recursive: true });
    // Build an isolated source copy. Never overwrite the user's .next or local env files.
    const source = join(root, "frontend");
    await cp(join(source, "src"), join(webRoot, "src"), { recursive: true });
    if (sessionProbe) {
      const page = join(webRoot, "src/app/session-probe");
      await mkdir(page, { recursive: true });
      await copyFile(join(__dirname, "probe-page.tsx"), join(page, "page.tsx"));
    }
    if (shellProbe) {
      for (const name of ["shell-probe", "shell-crash"]) {
        const page = join(webRoot, "src/app", name);
        await mkdir(page, { recursive: true });
        await copyFile(join(__dirname, `${name}.tsx`), join(page, "page.tsx"));
      }
    }
    for (const file of [
      "package.json",
      "tsconfig.json",
      "next.config.ts",
      "next-env.d.ts",
    ])
      await copyFile(join(source, file), join(webRoot, file));
    // Bound the isolated build to one worker: parallel route mkdir calls can
    // intermittently fail with EPERM on Windows. Keep the app config unchanged.
    const sourceConfig = relative(
      webRoot,
      join(source, "next.config"),
    ).replaceAll("\\", "/");
    await writeFile(
      join(webRoot, "next.config.ts"),
      `import config from ${JSON.stringify(sourceConfig)};\nexport default { ...config, experimental: { ...config.experimental, cpus: 1 } };\n`,
    );
    if (existsSync(join(source, "public")))
      await cp(join(source, "public"), join(webRoot, "public"), {
        recursive: true,
      });
    const env = {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_API_URL: apiUrl,
    };
    // Backend secrets are not passed to the frontend builder/server.
    for (const key of [
      "PATH",
      "Path",
      "PATHEXT",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "ComSpec",
      "SystemDrive",
      "ProgramFiles",
      "ProgramFiles(x86)",
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    const next = require.resolve("next/dist/bin/next");
    try {
      await execute(process.execPath, [next, "build"], {
        cwd: webRoot,
        env,
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      console.error(error.stdout ?? "", error.stderr ?? "");
      throw new Error("Không build được frontend test.");
    }
    server = spawn(
      process.execPath,
      [next, "start", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: webRoot,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [server.stdout, server.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-12000);
      });
    server.on("error", () => {});
    const deadline = Date.now() + 45000;
    while (true) {
      if (server.exitCode !== null || Date.now() >= deadline) {
        console.error(output);
        throw new Error("Frontend test không khởi động được.");
      }
      try {
        if ((await fetch(`${webOrigin}/login`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return {
      webOrigin,
      apiUrl,
      prisma,
      previewRoot,
      cleanup,
      expireAccessToken(token) {
        const claims = jwt.decode(token);
        return jwt.sign(
          { ...claims, exp: Math.floor(Date.now() / 1000) - 60 },
          config.auth.accessTokenSecret,
          { algorithm: "HS256" },
        );
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = { createFrontendFixture };
