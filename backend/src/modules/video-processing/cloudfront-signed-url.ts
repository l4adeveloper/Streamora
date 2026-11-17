import { createPrivateKey, sign } from "node:crypto";
import { ApiError } from "../../common/api-error";

// CloudFront's URL-safe base64 alphabet differs from RFC 4648 base64url.
function cloudFrontBase64(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/=/g, "_")
    .replace(/\//g, "~");
}

/** Sign one CDN object. Callers must authorize the viewer and constrain the object key. */
export function signCloudFrontUrl(
  url: string,
  keyPairId: string,
  privateKeyPem: string,
  expiresAt: number,
) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    !/^[A-Z0-9]{8,32}$/.test(keyPairId) ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= Date.now() / 1000
  ) {
    throw new ApiError(
      503,
      "VIDEO_DELIVERY_UNAVAILABLE",
      "Không thể cấp URL phát video.",
    );
  }
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: url,
        Condition: { DateLessThan: { "AWS:EpochTime": expiresAt } },
      },
    ],
  });
  let signature: Buffer;
  try {
    signature = sign(
      "RSA-SHA256",
      Buffer.from(policy),
      createPrivateKey(privateKeyPem),
    );
  } catch {
    throw new ApiError(
      503,
      "VIDEO_DELIVERY_UNAVAILABLE",
      "Khóa ký CDN không hợp lệ.",
    );
  }
  parsed.searchParams.set("Policy", cloudFrontBase64(policy));
  parsed.searchParams.set("Signature", cloudFrontBase64(signature));
  parsed.searchParams.set("Key-Pair-Id", keyPairId);
  parsed.searchParams.set("Hash-Algorithm", "SHA256");
  return parsed.toString();
}
