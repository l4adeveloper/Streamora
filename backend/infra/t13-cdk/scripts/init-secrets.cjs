const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createPublicKey } = require("node:crypto");
const {
  SecretsManagerClient,
  PutSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const {
  CloudFrontClient,
  GetPublicKeyCommand,
} = require("@aws-sdk/client-cloudfront");
const { base, loadConfig } = require("../lib/config.cjs");
const { readOutputs } = require("./outputs.cjs");

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !["--database", "--signing"].includes(arg)) ||
    !args.length
  )
    throw new Error(
      "Chọn --database, --signing hoặc cả hai. Chỉ cập nhật secret được chọn.",
    );
  const outputs = readOutputs(config.stackName);
  if (outputs.Account !== config.account || outputs.Region !== config.region)
    throw new Error("Outputs khác account/region của config.");
  if (outputs.PipelineEnabled !== "false")
    throw new Error(
      "Tắt pipelineEnabled và deploy trước khi nạp/đổi secret bằng công cụ setup.",
    );
  const values = [];
  if (args.includes("--database")) {
    const value = JSON.parse(
      readFileSync(resolve(base, ".local/database-secret.json"), "utf8"),
    );
    if (Object.keys(value).length !== 1 || typeof value.url !== "string")
      throw new Error("database-secret.json chỉ chứa key url.");
    const url = new URL(value.url);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname ||
      url.pathname === "/" ||
      !["require", "verify-ca", "verify-full"].includes(
        url.searchParams.get("sslmode"),
      )
    )
      throw new Error(
        "DB URL phải là PostgreSQL có database name và sslmode=require/verify-ca/verify-full.",
      );
    values.push([outputs.DatabaseSecretArn, JSON.stringify(value)]);
  }
  if (args.includes("--signing")) {
    const privateKey = readFileSync(
      resolve(base, ".local/cloudfront-private.pem"),
      "utf8",
    );
    const publicPem = createPublicKey(privateKey).export({
      type: "spki",
      format: "pem",
    });
    const expected = createPublicKey(config.publicKey).export({
      type: "spki",
      format: "pem",
    });
    if (publicPem !== expected)
      throw new Error("Private key không khớp public key trong config.");
    const cloudfront = new CloudFrontClient({ region: "us-east-1" });
    try {
      const deployed = await cloudfront.send(
        new GetPublicKeyCommand({ Id: outputs.CloudFrontPublicKeyId }),
      );
      const actual = createPublicKey(
        deployed.PublicKey.PublicKeyConfig.EncodedKey,
      ).export({ type: "spki", format: "pem" });
      if (actual !== expected)
        throw new Error(
          "Public key trên AWS không khớp. Chạy diff/deploy trước.",
        );
    } finally {
      cloudfront.destroy();
    }
    values.push([
      outputs.SigningSecretArn,
      JSON.stringify({ keyPairId: outputs.CloudFrontPublicKeyId, privateKey }),
    ]);
  }
  const client = new SecretsManagerClient({ region: config.region });
  try {
    for (const [SecretId, SecretString] of values) {
      await client.send(new PutSecretValueCommand({ SecretId, SecretString }));
      console.log(`Đã nạp secret: ${SecretId}`);
    }
  } finally {
    client.destroy();
  }
}
main().catch(() => {
  // SDK/database errors can contain sensitive request values; keep output deliberately minimal.
  console.error(
    "Không nạp được secret. Kiểm tra config, outputs, pipeline tắt, file .local, cặp khóa, TLS DB và quyền PutSecretValue của AWS profile. Không in nội dung secret.",
  );
  process.exitCode = 1;
});
