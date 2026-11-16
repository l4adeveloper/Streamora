const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const {
  signCloudCdnUrl,
} = require("../dist/modules/video-processing/cloud-cdn-signed-url");

const secret = Buffer.from("0123456789abcdef");
const encoded = secret.toString("base64url") + "==";
const resource = "https://cdn.example.com/groups/g/job/hls/segment-1.m4s";

test("Cloud CDN signature binds the HTTPS object, key name and expiry with padded base64url", () => {
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const signed = signCloudCdnUrl(resource, "video-v2", encoded, expiry);
  const parsed = new URL(signed);
  assert.equal(parsed.searchParams.get("Expires"), String(expiry));
  assert.equal(parsed.searchParams.get("KeyName"), "video-v2");
  const signature = parsed.searchParams.get("Signature");
  assert.match(signature, /^[A-Za-z0-9_-]{27}=$/);
  const input = signed.slice(0, signed.indexOf("&Signature="));
  assert.deepEqual(
    Buffer.from(signature, "base64url"),
    createHmac("sha1", secret).update(input).digest(),
  );
  for (const changed of [
    input.replace("segment-1", "segment-2"),
    input.replace("video-v2", "video-v3"),
    input.replace(String(expiry), String(expiry + 1)),
  ]) {
    assert.notDeepEqual(
      Buffer.from(signature, "base64url"),
      createHmac("sha1", secret).update(changed).digest(),
    );
  }
});

test("invalid configuration fails closed without including secret values in errors", () => {
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const cases = [
    ["http://cdn.example.com/a", "video-v2", encoded, expiry],
    ["https://user:pass@cdn.example.com/a", "video-v2", encoded, expiry],
    [resource + "?Signature=existing", "video-v2", encoded, expiry],
    [resource + "#fragment", "video-v2", encoded, expiry],
    ["https://cdn.example.com:8443/a", "video-v2", encoded, expiry],
    [resource, "invalid&key", encoded, expiry],
    [resource, "video-v2", "not-a-key", expiry],
    [resource, "video-v2", encoded, 1],
    [resource, "video-v2", encoded, Infinity],
    ["not a URL", "video-v2", encoded, expiry],
  ];
  for (const args of cases) {
    assert.throws(
      () => signCloudCdnUrl(...args),
      (error) => {
        assert.equal(error.message.includes(encoded), false);
        return true;
      },
    );
  }
});
