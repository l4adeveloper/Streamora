const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createPublicKey } = require("node:crypto");
const defaults = require("../t13.config.example.json");
const base = resolve(__dirname, "..");
const configPath = resolve(base, process.env.T13_CONFIG || "t13.config.json");

function validateConfig(c) {
  const fail = (field) => {
    throw new Error(`Cấu hình T13 không hợp lệ: ${field}`);
  };
  const fields = [
    ...Object.keys(defaults),
    "existingOutputBucket",
    "databaseSecretArn",
    "signingSecretArn",
    "apiRuntimeRoleName",
    "apiRuntimeUserName",
    "vpc",
  ];
  for (const field of Object.keys(c)) if (!fields.includes(field)) fail(field);
  if (!/^\d{12}$/.test(c.account)) fail("account");
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(c.region)) fail("region");
  if (!c.namePrefix || !c.stackName || !c.sourceBucketName || !c.outputBucketName)
    fail("tên tài nguyên");
  if (c.sourceBucketName === c.outputBucketName) fail("outputBucketName phải khác source");
  if (!/^[a-z0-9.-]+$/.test(c.apiOriginDomain || "")) fail("apiOriginDomain");
  try {
    const url = new URL(c.webOrigin);
    if (url.protocol !== "https:" || url.origin !== c.webOrigin) fail("webOrigin");
  } catch {
    fail("webOrigin");
  }
  if (typeof c.pipelineEnabled !== "boolean") fail("pipelineEnabled");
  if (c.existingOutputBucket !== undefined && typeof c.existingOutputBucket !== "boolean")
    fail("existingOutputBucket");
  if (![360, 480, 720, 1080, 1440, 2160].includes(c.maxQuality)) fail("maxQuality");
  if (
    !Array.isArray(c.optionalQualities) ||
    c.optionalQualities.some((q) => ![480, 1440].includes(q))
  )
    fail("optionalQualities");
  for (const kind of ["database", "signing"]) {
    if (
      c[`${kind}SecretArn`] &&
      !c[`${kind}SecretArn`].startsWith(`arn:aws:secretsmanager:${c.region}:${c.account}:secret:`)
    )
      fail(`${kind}SecretArn`);
  }
  if (
    c.databaseSecretName === c.signingSecretName ||
    (c.databaseSecretArn && c.databaseSecretArn === c.signingSecretArn)
  )
    fail("DB và signing phải dùng secret riêng");
  if (c.apiRuntimeRoleName && c.apiRuntimeUserName) fail("chỉ chọn API role hoặc user");
  if (
    c.vpc &&
    (!c.vpc.vpcId ||
      !c.vpc.privateSubnetIds?.length ||
      !c.vpc.securityGroupIds?.length ||
      c.vpc.privateSubnetIds.length !== c.vpc.availabilityZones?.length)
  )
    fail("vpc");
  if (c.vpc !== undefined && (!c.vpc || typeof c.vpc !== "object")) fail("vpc");
  return c;
}

function readConfig() {
  return validateConfig({ ...defaults, ...JSON.parse(readFileSync(configPath, "utf8")) });
}

function loadConfig() {
  const config = readConfig();
  const publicKey = readFileSync(resolve(base, config.publicKeyPath), "utf8");
  if (!publicKey.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Cần public PEM, không phải private key.");
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength !== 2048)
    throw new Error("Cần RSA public key 2048 bit.");
  return { ...config, publicKey };
}
module.exports = { base, configPath, readConfig, loadConfig, validateConfig };
