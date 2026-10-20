import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function writeIfMissing(path, content) {
  try {
    await writeFile(path, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return "created";
  } catch (error) {
    if (error.code === "EEXIST") return "preserved";
    throw error;
  }
}

export async function setupEnvironment(root = repositoryRoot) {
  const result = [];
  const template = (path) => readFile(resolve(root, path), "utf8");
  const infrastructure = (await template(".env.example"))
    .replace(
      "POSTGRES_PASSWORD=replace-with-local-password",
      `POSTGRES_PASSWORD=${randomBytes(24).toString("base64url")}`,
    )
    .replace(
      "RABBITMQ_PASSWORD=replace-with-local-password",
      `RABBITMQ_PASSWORD=${randomBytes(24).toString("base64url")}`,
    );
  result.push({
    path: ".env",
    status: await writeIfMissing(resolve(root, ".env"), infrastructure),
  });

  // Read the actual file, including an existing one, to keep credentials aligned.
  const infrastructureEnv = parseEnv(await template(".env"));
  const databasePassword = infrastructureEnv.POSTGRES_PASSWORD;
  const rabbitPassword = infrastructureEnv.RABBITMQ_PASSWORD;
  if (!databasePassword || !rabbitPassword) {
    throw new Error(
      "Thiếu POSTGRES_PASSWORD hoặc RABBITMQ_PASSWORD trong .env gốc.",
    );
  }
  const backend = (await template("backend/.env.example"))
    .replace(
      "ACCESS_TOKEN_SECRET=replace-with-generated-secret",
      `ACCESS_TOKEN_SECRET=${randomBytes(48).toString("base64url")}`,
    )
    .replace(
      "streamora:replace-with-local-password@127.0.0.1:5432",
      `streamora:${encodeURIComponent(databasePassword)}@127.0.0.1:5432`,
    )
    .replace(
      "streamora:replace-with-local-password@127.0.0.1:5672",
      `streamora:${encodeURIComponent(rabbitPassword)}@127.0.0.1:5672`,
    );
  result.push({
    path: "backend/.env",
    status: await writeIfMissing(resolve(root, "backend/.env"), backend),
  });
  result.push({
    path: "apps/web/.env.local",
    status: await writeIfMissing(
      resolve(root, "apps/web/.env.local"),
      await template("apps/web/.env.example"),
    ),
  });
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    for (const file of await setupEnvironment()) {
      console.log(
        `${file.status === "created" ? "Đã tạo" : "Giữ nguyên"}: ${file.path}`,
      );
    }
    console.log(
      "Cấu hình local sẵn sàng. File đã có không bị ghi đè; không in secrets.",
    );
  } catch {
    console.error(
      "Không thể tạo cấu hình local. Kiểm tra quyền ghi và POSTGRES_PASSWORD/RABBITMQ_PASSWORD trong .env gốc.",
    );
    process.exitCode = 1;
  }
}
