import { resolve } from "node:path";
import { defineConfig } from "prisma/config";
import { loadEnvironmentFile } from "./src/config/environment";

loadEnvironmentFile(resolve(__dirname, ".env"));

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Generation/validation work on a clean checkout before setup:env.
  // Migration and runtime commands still require a configured DATABASE_URL.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
