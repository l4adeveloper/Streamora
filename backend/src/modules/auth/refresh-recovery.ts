import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

// Domain separation keeps this key independent from JWT signing. All API
// instances use the same server secret; recovery never relies on process memory.
function key(secret: string) {
  return Buffer.from(
    hkdfSync("sha256", secret, "streamora", "refresh-recovery-v1", 32),
  );
}

export function sealRefreshToken(
  token: string,
  secret: string,
  sessionId: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(sessionId));
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}

export function openRefreshToken(
  sealed: string,
  secret: string,
  sessionId: string,
): string | null {
  try {
    const data = Buffer.from(sealed, "base64url");
    // 12-byte nonce, 16-byte authentication tag, 43-byte refresh token.
    if (data.length !== 71) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(secret),
      data.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(sessionId));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
