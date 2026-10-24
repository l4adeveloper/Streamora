import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

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
  // DATABASE_URL points at the team's PostgreSQL server; it stays a placeholder
  // until filled in by hand, so no credential is generated or guessed here.
  const backend = (await template("backend/.env.example")).replace(
    "ACCESS_TOKEN_SECRET=replace-with-generated-secret",
    `ACCESS_TOKEN_SECRET=${randomBytes(48).toString("base64url")}`,
  );
  result.push({
    path: "backend/.env",
    status: await writeIfMissing(resolve(root, "backend/.env"), backend),
  });
  result.push({
    path: "frontend/.env.local",
    status: await writeIfMissing(
      resolve(root, "frontend/.env.local"),
      await template("frontend/.env.example"),
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
      "Cấu hình local sẵn sàng. Điền DATABASE_URL trong backend/.env; file đã có không bị ghi đè, không in secrets.",
    );
  } catch {
    console.error("Không thể tạo cấu hình local. Kiểm tra quyền ghi.");
    process.exitCode = 1;
  }
}
