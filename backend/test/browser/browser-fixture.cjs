const { createServer, request: httpRequest } = require("node:http");
const { createServer: createHttpsServer } = require("node:https");
const { randomBytes } = require("node:crypto");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { join, dirname, basename, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../../dist/modules/app.module");
const { configureApplication } = require("../../dist/app");
const { readEnvironment } = require("../../dist/config/environment");

const execute = promisify(execFile);
const blankPage = (_request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(
    "<!doctype html><html><head><title>Session browser test</title></head><body>Isolated test origin</body></html>",
  );
};
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}
async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closed;
}

async function createTestTls() {
  const directory = await mkdtemp(join(tmpdir(), "streamora-browser-tls-"));
  const cleanup = async () => {
    if (
      dirname(directory) !== resolve(tmpdir()) ||
      !/^streamora-browser-tls-[A-Za-z0-9]+$/.test(basename(directory))
    ) {
      throw new Error("Đường dẫn TLS tạm không hợp lệ.");
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const gitOpenSsl = "C:/Program Files/Git/usr/bin/openssl.exe";
    const openssl =
      process.env.STREAMORA_TEST_OPENSSL ??
      (existsSync(gitOpenSsl) ? gitOpenSsl : "openssl");
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    const config = join(directory, "openssl.cnf");
    await writeFile(config, "[req]\ndistinguished_name=dn\n[dn]\n");
    await execute(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=streamora.test",
        "-config",
        config,
        "-addext",
        "subjectAltName=DNS:app.streamora.test,DNS:api.streamora.test",
      ],
      { timeout: 15000, windowsHide: true },
    );
    return {
      options: { key: await readFile(key), cert: await readFile(cert) },
      cleanup,
    };
  } catch {
    await cleanup();
    throw new Error(
      "Không tạo được TLS tạm cho browser test. Cài OpenSSL hoặc đặt STREAMORA_TEST_OPENSSL tới openssl.exe của Git for Windows.",
    );
  }
}

async function createBrowserProfile(
  databaseUrl,
  tls,
  { docsEnabled = false } = {},
) {
  const secure = Boolean(tls);
  const logs = [];
  let app, webServer, proxy;
  const cleanup = async () => {
    await closeServer(proxy);
    await closeServer(webServer);
    if (app) await app.close();
  };
  try {
    webServer = secure
      ? createHttpsServer(tls, blankPage)
      : createServer(blankPage);
    const webPort = await listen(webServer);
    const webOrigin = secure
      ? `https://app.streamora.test:${webPort}`
      : `http://127.0.0.1:${webPort}`;
    const config = readEnvironment({
      NODE_ENV: secure ? "production" : "test",
      API_DOCS_ENABLED: String(docsEnabled),
      DATABASE_URL: databaseUrl,
      WEB_ORIGIN: webOrigin,
      ACCESS_TOKEN_SECRET: randomBytes(48).toString("base64url"),
      AUTH_COOKIE_SECURE: String(secure),
      AUTH_COOKIE_SAME_SITE: "lax",
    });
    app = await NestFactory.create(AppModule.forRoot(config), {
      logger: false,
    });
    configureApplication(app, config, {
      requestLog: (entry) => logs.push(entry),
    });
    await app.listen(0, "127.0.0.1");
    const internalUrl = new URL(await app.getUrl());
    let apiUrl = `${internalUrl.origin}/api/v1`;
    if (secure) {
      // Emulate TLS termination in staging; production app code remains HTTP behind a proxy.
      proxy = createHttpsServer(tls, (incoming, outgoing) => {
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: internalUrl.port,
            method: incoming.method,
            path: incoming.url,
            headers: incoming.headers,
          },
          (response) => {
            outgoing.writeHead(response.statusCode, response.headers);
            response.pipe(outgoing);
          },
        );
        upstream.on("error", () => {
          if (!outgoing.headersSent) outgoing.writeHead(502);
          outgoing.end();
        });
        incoming.pipe(upstream);
      });
      apiUrl = `https://api.streamora.test:${await listen(proxy)}/api/v1`;
    }
    return { apiUrl, webOrigin, logs, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function createUntrustedOrigin() {
  const server = createServer(blankPage);
  return {
    url: `http://127.0.0.1:${await listen(server)}`,
    cleanup: () => closeServer(server),
  };
}

module.exports = { createTestTls, createBrowserProfile, createUntrustedOrigin };
