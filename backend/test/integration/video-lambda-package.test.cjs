const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { resolve, join, relative, sep } = require("node:path");
const { tmpdir } = require("node:os");

test("the standalone ZIP loads outside the repository without Prisma, PostgreSQL, node_modules or application secrets", () => {
  const zip = resolve(__dirname, "../../dist/video-lambda.zip");
  const metadata = JSON.parse(
    readFileSync(
      resolve(__dirname, "../../dist/video-lambda/metafile.json"),
      "utf8",
    ),
  );
  const inputs = Object.keys(metadata.inputs);
  assert.ok(
    !inputs.some((f) =>
      /(?:generated[\\/]prisma|node_modules[\\/](?:@prisma|pg[\\/]|pg-pool))/.test(
        f,
      ),
    ),
  );
  const entries = execFileSync("tar", ["-tf", zip], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/);
  assert.deepEqual(entries, ["index.cjs"]);
  const folder = mkdtempSync(join(tmpdir(), "streamora-video-zip-"));
  try {
    execFileSync("tar", ["-xf", zip, "-C", folder]);
    const result = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const assert=require('node:assert/strict');
      const runtime=require('./index.cjs');
      const config=runtime.readVideoLambdaConfig({NODE_ENV:'production',VIDEO_MODE:'aws',VIDEO_WORKER_ENABLED:'false',
        FILES_S3_REGION:'ap-northeast-1',FILES_S3_BUCKET:'video-source',VIDEO_DYNAMODB_TABLE:'video-jobs',
        VIDEO_AWS_ACCOUNT_ID:'123456789012',VIDEO_OUTPUT_BUCKET:'video-output',
        VIDEO_MEDIACONVERT_ROLE_ARN:'arn:aws:iam::123456789012:role/video',
        VIDEO_MEDIACONVERT_QUEUE_ARN:'arn:aws:mediaconvert:ap-northeast-1:123456789012:queues/video'});
      assert.equal(config.video.tableName,'video-jobs');
      const handle=runtime.createVideoLambdaHandler(config,()=>({store:{due:async()=>[],cleanup:async()=>{}},storage:{},worker:{once:async()=>{throw new Error('unexpected')}}}));
      handle({action:'maintenance'},{getRemainingTimeInMillis:()=>300000}).then(result=>{
        assert.equal(result.ok,true);console.log('standalone-ok');
      }).catch(()=>process.exitCode=1);
    `,
      ],
      {
        cwd: folder,
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
        timeout: 15000,
      },
    );
    assert.match(result, /standalone-ok/);
  } finally {
    const child = relative(resolve(tmpdir()), resolve(folder));
    assert.ok(child && child !== ".." && !child.startsWith(".." + sep));
    rmSync(folder, { recursive: true, force: true });
  }
});
