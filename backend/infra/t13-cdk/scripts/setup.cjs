const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { createPublicKey } = require("node:crypto");
const { base, configPath, readConfig, loadConfig } = require("../lib/config.cjs");
const { awsCli } = require("../lib/aws-cli.cjs");
const { cleanup } = require("./cleanup.cjs");
const { recoverStack } = require("./recover-stack.cjs");

function run(file, args, cwd = base) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new Error(`Bước ${args[0] || file} thất bại; chưa chạy bước tiếp theo.`);
}

async function main() {
  mkdirSync(resolve(base, ".local"), { recursive: true });
  const dbFile = resolve(base, ".local/database-secret.json");
  if (!existsSync(configPath))
    writeFileSync(configPath, readFileSync(resolve(base, "t13.config.example.json")));
  if (!existsSync(dbFile))
    writeFileSync(dbFile, JSON.stringify({ url: "" }, null, 2), { mode: 0o600 });
  const c = readConfig();
  let db;
  try {
    db = JSON.parse(readFileSync(dbFile, "utf8"));
  } catch {
    throw new Error("database-secret.json không đúng JSON.");
  }
  if (!db?.url) {
    console.log(
      `Điền cấu hình: ${configPath}\nĐiền DB URL: ${dbFile}\nSau đó chạy lại npm run setup:t13.`,
    );
    return;
  }
  const url = new URL(db.url);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname === "/" ||
    !url.pathname ||
    Object.keys(db).length !== 1 ||
    !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode"))
  )
    throw new Error("DB URL cần PostgreSQL và sslmode=require (hoặc verify-full).");
  run(resolve(base, "scripts/keys.cjs"), []);
  const key = loadConfig();
  const publicPem = (pem) => createPublicKey(pem).export({ type: "spki", format: "pem" });
  if (
    publicPem(key.publicKey) !==
    publicPem(readFileSync(resolve(base, ".local/cloudfront-private.pem")))
  )
    throw new Error("Public key trong config không khớp private key .local.");
  if (!existsSync(resolve(base, "node_modules/aws-cdk/bin/cdk")))
    run(process.env.npm_execpath, ["ci"]);
  const aws = awsCli(c.region);
  if (aws(["sts", "get-caller-identity"]).Account !== c.account)
    throw new Error("AWS profile khác account trong config.");
  aws([
    "s3api",
    "head-bucket",
    "--bucket",
    c.sourceBucketName,
    "--expected-bucket-owner",
    c.account,
  ]);
  const location =
    aws(["s3api", "get-bucket-location", "--bucket", c.sourceBucketName]).LocationConstraint ||
    "us-east-1";
  if (location !== c.region) throw new Error("Region bucket nguồn không khớp config.");
  run(process.env.npm_execpath, ["run", "package:video-lambda"], resolve(base, "../../.."));
  await recoverStack(c.stackName, aws);

  // Reuse existing data resources. Never turn a stack-owned bucket/secret into an import.
  let owned = [];
  try {
    owned =
      aws(["cloudformation", "list-stack-resources", "--stack-name", c.stackName])
        .StackResourceSummaries || [];
  } catch (error) {
    if (!/\(ValidationError\).*does not exist/.test(error.message)) throw error;
  }
  if (
    !owned.some(
      (r) => r.ResourceType === "AWS::S3::Bucket" && r.PhysicalResourceId === c.outputBucketName,
    )
  ) {
    c.existingOutputBucket = !!aws(
      [
        "s3api",
        "head-bucket",
        "--bucket",
        c.outputBucketName,
        "--expected-bucket-owner",
        c.account,
      ],
      ["404", "NoSuchBucket"],
    );
    if (c.existingOutputBucket) {
      const region =
        aws(["s3api", "get-bucket-location", "--bucket", c.outputBucketName]).LocationConstraint ||
        "us-east-1";
      if (region !== c.region) throw new Error("Region bucket output không khớp config.");
    }
  } else c.existingOutputBucket = false;
  for (const kind of ["database", "signing"]) {
    const secret = aws(
      [
        "secretsmanager",
        "describe-secret",
        "--secret-id",
        c[`${kind}SecretArn`] || c[`${kind}SecretName`],
      ],
      ["ResourceNotFoundException"],
    );
    if (secret?.DeletedDate)
      throw new Error(`Secret ${kind} đang chờ xóa. Khôi phục secret trước.`);
    if (secret) {
      if (
        owned.some(
          (r) =>
            r.ResourceType === "AWS::SecretsManager::Secret" && r.PhysicalResourceId === secret.ARN,
        )
      )
        delete c[`${kind}SecretArn`];
      else c[`${kind}SecretArn`] = secret.ARN;
    } else delete c[`${kind}SecretArn`];
  }
  await cleanup(c, aws);
  if (c.existingOutputBucket) {
    aws([
      "s3api",
      "put-public-access-block",
      "--bucket",
      c.outputBucketName,
      "--public-access-block-configuration",
      JSON.stringify({
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      }),
    ]);
    aws([
      "s3api",
      "put-bucket-ownership-controls",
      "--bucket",
      c.outputBucketName,
      "--ownership-controls",
      JSON.stringify({ Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] }),
    ]);
  }
  c.pipelineEnabled = false;
  writeFileSync(configPath, JSON.stringify(c, null, 2) + "\n");
  const cdk = require.resolve("aws-cdk/bin/cdk");
  if (
    !aws(["cloudformation", "describe-stacks", "--stack-name", "CDKToolkit"], ["ValidationError"])
  )
    run(cdk, ["bootstrap", `aws://${c.account}/${c.region}`, "--no-bootstrap-customer-key"]);
  run(cdk, ["deploy", "--require-approval", "broadening", "--outputs-file", "cdk.outputs.json"]);
  run(resolve(base, "scripts/init-secrets.cjs"), ["--database", "--signing"]);
  c.pipelineEnabled = true;
  writeFileSync(configPath, JSON.stringify(c, null, 2) + "\n");
  run(cdk, ["deploy", "--require-approval", "broadening", "--outputs-file", "cdk.outputs.json"]);
  run(resolve(base, "scripts/api-env.cjs"), []);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
