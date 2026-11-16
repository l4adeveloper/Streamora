import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { EnvironmentConfig } from "../config/environment";

const execute = promisify(execFile);
export class MigrationDeployError extends Error {}

/** Apply pending migrations before API workers and requests can use the schema. */
export async function deployMigrations(
  config: Pick<EnvironmentConfig, "nodeEnv" | "databaseUrl">,
  run = execute,
) {
  if (config.nodeEnv === "test") return;
  const directory = resolve(__dirname, "../..");
  const prisma = resolve(
    dirname(require.resolve("prisma/package.json")),
    require("prisma/package.json").bin.prisma,
  );
  try {
    await run(process.execPath, [prisma, "migrate", "deploy"], {
      cwd: directory,
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    console.log("Đã kiểm tra và áp dụng database migrations.");
  } catch {
    // Child errors can contain the database connection string; do not log them.
    throw new MigrationDeployError(
      "Không áp dụng được database migrations. API chưa khởi động; kiểm tra kết nối/quyền database và trạng thái migration.",
    );
  }
}
