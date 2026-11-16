const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const {
  deployMigrations,
  MigrationDeployError,
} = require("../dist/database/deploy-migrations");
const {
  readVideoConfig,
} = require("../dist/modules/video-processing/video-config");

test("API startup migrates with both development/default and production environments; isolated tests skip it", async () => {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  await deployMigrations({ nodeEnv: "test", databaseUrl: "unused" }, run);
  assert.equal(calls.length, 0);
  for (const nodeEnv of ["development", "production"])
    await deployMigrations(
      { nodeEnv, databaseUrl: "postgresql://test:fake@localhost/deploy" },
      run,
    );
  assert.equal(calls.length, 2);
  for (const [executable, args, options] of calls) {
    assert.equal(executable, process.execPath);
    assert.equal(existsSync(args[0]), true);
    assert.deepEqual(args.slice(1), ["migrate", "deploy"]);
    assert.equal(
      options.env.DATABASE_URL,
      "postgresql://test:fake@localhost/deploy",
    );
    assert.equal(
      existsSync(require("node:path").join(options.cwd, "prisma.config.ts")),
      true,
    );
  }
});

test("migration failure stops startup without exposing the child process error", async () => {
  await assert.rejects(
    deployMigrations(
      { nodeEnv: "production", databaseUrl: "unused" },
      async () => {
        throw new Error("sensitive-database-connection-string");
      },
    ),
    (error) =>
      error instanceof MigrationDeployError &&
      !error.message.includes("sensitive"),
  );
});

test("production recording has an npm-installed FFmpeg even when the existing encoder is MediaConvert", () => {
  const c = readVideoConfig({ NODE_ENV: "production" }, "s3", "ap-northeast-1");
  assert.equal(c.mode, "aws");
  assert.equal(c.ffmpegPath, require("ffmpeg-static"));
  assert.equal(existsSync(c.ffmpegPath), true);
});
