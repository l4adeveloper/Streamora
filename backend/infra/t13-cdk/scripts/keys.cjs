const { generateKeyPairSync, createPublicKey } = require("node:crypto");
const {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} = require("node:fs");
const { resolve } = require("node:path");
const { base } = require("../lib/config.cjs");
const folder = resolve(base, ".local");
const privatePath = resolve(folder, "cloudfront-private.pem");
const publicPath = resolve(folder, "cloudfront-public.pem");
mkdirSync(folder, { recursive: true, mode: 0o700 });
if (existsSync(privatePath) || existsSync(publicPath)) {
  if (!existsSync(privatePath) || !existsSync(publicPath))
    throw new Error(
      "Cặp khóa chưa đầy đủ. Khôi phục từ backup; không tự ghi đè khóa.",
    );
  const derived = createPublicKey(readFileSync(privatePath)).export({
    type: "spki",
    format: "pem",
  });
  const saved = createPublicKey(readFileSync(publicPath)).export({
    type: "spki",
    format: "pem",
  });
  if (derived !== saved)
    throw new Error("Public/private key không khớp. Không ghi đè khóa.");
  console.log("Đã có cặp khóa phù hợp; giữ nguyên.");
} else {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(privatePath, pair.privateKey, { flag: "wx", mode: 0o600 });
  writeFileSync(publicPath, pair.publicKey, { flag: "wx", mode: 0o600 });
  console.log(
    "Đã tạo cặp RSA 2048 trong .local. Backup private key ở nơi an toàn; không commit.",
  );
}
