import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const execute = promisify(execFile);
const directory = fileURLToPath(
  new URL("../infra/docker/staging/", import.meta.url),
);
const envPath = resolve(directory, ".env");
const tls = resolve(directory, "tls");
try {
  await mkdir(tls, { recursive: true });
  if (!existsSync(envPath)) {
    await writeFile(
      envPath,
      [
        `T01_POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}`,
        `T01_ACCESS_TOKEN_SECRET=${randomBytes(48).toString("hex")}`,
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
  }
  const key = resolve(tls, "key.pem");
  const cert = resolve(tls, "cert.pem");
  if (existsSync(key) !== existsSync(cert)) {
    throw new Error(
      "Cặp TLS chưa đầy đủ; kiểm tra thư mục backend/infra/docker/staging/tls.",
    );
  }
  if (!existsSync(key)) {
    const gitOpenSsl = "C:/Program Files/Git/usr/bin/openssl.exe";
    const openssl =
      process.env.STREAMORA_TEST_OPENSSL ??
      (existsSync(gitOpenSsl) ? gitOpenSsl : "openssl");
    const config = resolve(tls, "openssl.cnf");
    await writeFile(config, "[req]\ndistinguished_name=dn\n[dn]\n");
    await execute(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "30",
        "-subj",
        "/CN=localhost",
        "-config",
        config,
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { windowsHide: true, timeout: 20000 },
    );
  }
  await access(cert);
  console.log("T01 staging local: env/TLS sẵn sàng; giữ nguyên file đã có.");
  console.log(
    "URL: https://localhost:8443 — certificate tự ký, chỉ chạy trên máy này.",
  );
} catch {
  console.error(
    "Không chuẩn bị được staging. Cần OpenSSL (Git for Windows) và quyền ghi backend/infra/docker/staging; không in secrets.",
  );
  process.exitCode = 1;
}
