import { createHmac } from "node:crypto";
import { ApiError } from "../../common/api-error";

/** Sign a single object after the caller authorizes the viewer and scopes its key. */
export function signCloudCdnUrl(
  resource: string,
  keyName: string,
  encodedKey: string,
  expiresAt: number,
) {
  const unavailable = (): never => {
    throw new ApiError(
      503,
      "VIDEO_DELIVERY_UNAVAILABLE",
      "Không thể cấp URL phát video.",
    );
  };
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return unavailable();
  }
  const secret = encodedKey.trim();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{1,63}$/.test(keyName) ||
    !/^[A-Za-z0-9_-]{22}==$/.test(secret) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() / 1000
  )
    return unavailable();
  const key = Buffer.from(secret, "base64url");
  if (key.length !== 16 || `${key.toString("base64url")}==` !== secret)
    return unavailable();
  // Cloud CDN uses RFC 4648 base64url WITH padding, unlike CloudFront.
  // https://docs.cloud.google.com/cdn/docs/using-signed-urls
  const input = `${url.href}?Expires=${expiresAt}&KeyName=${keyName}`;
  const signature = createHmac("sha1", key)
    .update(input)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${input}&Signature=${signature}`;
}
