const { loadConfig } = require("../lib/config.cjs");
const { readOutputs } = require("./outputs.cjs");
const config = loadConfig();
const o = readOutputs(config.stackName);
if (o.Account !== config.account || o.Region !== config.region)
  throw new Error(
    "Outputs khác account/region của config; deploy lại đúng stack trước.",
  );
console.log(
  [
    "# Ghép các dòng này vào backend/.env trên EC2; giữ DATABASE_URL/auth/upload/IVS/chat hiện có.",
    "NODE_ENV=production",
    `WEB_ORIGIN=${o.WebOrigin}`,
    "AUTH_COOKIE_SECURE=true",
    "AUTH_COOKIE_SAME_SITE=lax",
    "FILES_STORAGE_DRIVER=s3",
    `FILES_S3_BUCKET=${o.SourceBucket}`,
    `FILES_S3_REGION=${o.Region}`,
    "VIDEO_MODE=aws",
    "VIDEO_WORKER_ENABLED=false",
    `VIDEO_AWS_ACCOUNT_ID=${o.Account}`,
    `VIDEO_OUTPUT_BUCKET=${o.OutputBucket}`,
    `VIDEO_MEDIA_DOMAIN=${o.MediaDomain}`,
    `VIDEO_SIGNING_SECRET_ARN=${o.SigningSecretArn}`,
  ].join("\n"),
);
