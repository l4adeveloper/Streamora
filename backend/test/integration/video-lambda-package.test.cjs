const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { join, dirname, resolve, basename } = require("node:path");
const { tmpdir } = require("node:os");
const { inflateRawSync } = require("node:zlib");
const { randomUUID } = require("node:crypto");
const { createMeetingFixture } = require("../meeting-fixture.cjs");

test(
  "uploaded ZIP runs without node_modules or native Prisma engines and queries the isolated DB",
  { timeout: 60000 },
  async () => {
    const zip = readFileSync(join(__dirname, "../../dist/video-lambda.zip"));
    const end = zip.lastIndexOf(Buffer.from("PK\x05\x06", "binary"));
    assert.ok(end > 0);
    assert.equal(zip.readUInt16LE(end + 10), 1); // Allowlisted single-file artifact.
    const central = zip.readUInt32LE(end + 16);
    const name = zip
      .subarray(central + 46, central + 46 + zip.readUInt16LE(central + 28))
      .toString();
    assert.equal(name, "index.cjs");
    const local = zip.readUInt32LE(central + 42);
    const compressedSize = zip.readUInt32LE(central + 20);
    const data =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const source = inflateRawSync(zip.subarray(data, data + compressedSize));
    assert.equal(source.length, zip.readUInt32LE(central + 24));
    const directory = mkdtempSync(join(tmpdir(), "streamora-lambda-package-"));
    let fixture, runtime;
    try {
      writeFileSync(join(directory, name), source);
      const bundled = require(join(directory, name));
      assert.equal(typeof bundled.handler, "function");
      const config = bundled.readVideoLambdaConfig({
        NODE_ENV: "production",
        VIDEO_MODE: "aws",
        VIDEO_WORKER_ENABLED: "false",
        FILES_S3_REGION: "ap-northeast-1",
        FILES_S3_BUCKET: "source-bucket",
        VIDEO_AWS_ACCOUNT_ID: "586481704097",
        VIDEO_OUTPUT_BUCKET: "output-bucket",
        VIDEO_DATABASE_SECRET_ARN:
          "arn:aws:secretsmanager:ap-northeast-1:586481704097:secret:database-abcdef",
        VIDEO_MEDIACONVERT_ROLE_ARN: "arn:aws:iam::586481704097:role/encode",
        VIDEO_MEDIACONVERT_QUEUE_ARN:
          "arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/video",
        VIDEO_DISPATCH_QUEUE_URL:
          "https://sqs.ap-northeast-1.amazonaws.com/586481704097/dispatch",
        VIDEO_COMPLETION_QUEUE_URL:
          "https://sqs.ap-northeast-1.amazonaws.com/586481704097/completion",
      });
      fixture = await createMeetingFixture();
      runtime = bundled.createVideoRuntime(config, fixture.config.databaseUrl);
      assert.deepEqual(await runtime.db.$queryRaw`SELECT 1 AS value`, [
        { value: 1 },
      ]);
      assert.equal(await runtime.worker.once(randomUUID()), false);
    } finally {
      if (runtime) {
        await runtime.worker.onModuleDestroy();
        await runtime.db.$disconnect();
      }
      await fixture?.cleanup();
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith("streamora-lambda-package-"));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
