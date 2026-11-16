const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

test("API loads service-account credentials from backend env without EC2 instance credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "streamora-aws-env-"));
  try {
    const path = join(dir, "backend.env");
    await writeFile(
      path,
      "AWS_ACCESS_KEY_ID=test-service-account\nAWS_SECRET_ACCESS_KEY=test-service-secret\n",
    );
    const env = { ...process.env, AWS_EC2_METADATA_DISABLED: "true" };
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
    ])
      delete env[key];
    const result = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const assert = require('node:assert/strict');
      const { loadEnvironmentFile } = require('./backend/dist/config/environment');
      const { DynamoVideoJobs } = require('./backend/dist/modules/video-processing/dynamodb-video-jobs');
      const { S3Client } = require('@aws-sdk/client-s3');
      const { MediaConvertEncoder } = require('./backend/dist/modules/video-processing/mediaconvert-encoder');
      loadEnvironmentFile(process.argv[1]);
      const store = new DynamoVideoJobs({ region: 'ap-northeast-1' }, 'source');
      const s3 = new S3Client({ region: 'ap-northeast-1' });
      const encoder = new MediaConvertEncoder({ region: 'ap-northeast-1' });
      (async () => {
        for (const client of [store.client, s3, encoder.client]) {
          const credentials = await client.config.credentials();
          assert.equal(credentials.accessKeyId, 'test-service-account');
          assert.equal(credentials.secretAccessKey, 'test-service-secret');
        }
        store.close(); s3.destroy(); encoder.close(); console.log('ok');
      })().catch(() => { process.exitCode = 1; });
    `,
        path,
      ],
      { cwd: resolve(__dirname, "../.."), env, encoding: "utf8" },
    );
    assert.equal(result.trim(), "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
