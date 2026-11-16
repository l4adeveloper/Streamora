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

test("production startup runs the bundled migration command with the configured DB; development builds need no DB", async () => {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  await deployMigrations(
    { nodeEnv: "development", databaseUrl: "unused" },
    run,
  );
  assert.equal(calls.length, 0);
  await deployMigrations(
    {
      nodeEnv: "production",
      databaseUrl: "postgresql://test:fake@localhost/deploy",
    },
    run,
  );
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
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
