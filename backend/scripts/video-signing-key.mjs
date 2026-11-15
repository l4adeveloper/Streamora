import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Local files only. Public key ID is returned by CloudFront Console after upload.
const keyPairId = process.argv[2];
if (process.argv.length > 3 || (keyPairId && !/^[A-Z0-9]+$/.test(keyPairId)))
  throw new Error(
    "Dùng: npm run video:signing-key -- [CLOUDFRONT_PUBLIC_KEY_ID]",
  );
const folder = new URL("../infra/t13/.local/", import.meta.url);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const privatePath = new URL("cloudfront-private.pem", folder);
const publicPath = new URL("cloudfront-public.pem", folder);
if (!existsSync(privatePath) && !existsSync(publicPath)) {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(privatePath, keys.privateKey, { flag: "wx", mode: 0o600 });
  writeFileSync(publicPath, keys.publicKey, { flag: "wx", mode: 0o600 });
}
if (!existsSync(privatePath) || !existsSync(publicPath))
  throw new Error("Thiếu một khóa. Khôi phục cặp khóa cũ; không tự ghi đè.");
const privateKey = readFileSync(privatePath, "utf8");
const key = createPublicKey(privateKey);
if (
  key.asymmetricKeyType !== "rsa" ||
  key.asymmetricKeyDetails.modulusLength !== 2048 ||
  key.export({ type: "spki", format: "pem" }) !==
    createPublicKey(readFileSync(publicPath)).export({
      type: "spki",
      format: "pem",
    })
)
  throw new Error("Cặp khóa không khớp hoặc không phải RSA 2048.");
console.log(`Public key để đưa lên CloudFront: ${fileURLToPath(publicPath)}`);
if (keyPairId) {
  const payload = new URL("signing-secret.json", folder);
  writeFileSync(
    payload,
    JSON.stringify({ keyPairId, privateKey }, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(`JSON để dán vào Secrets Manager: ${fileURLToPath(payload)}`);
}
