const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, verify } = require("node:crypto");
const {
  signCloudFrontUrl,
} = require("../dist/modules/video-processing/cloudfront-signed-url");
const {
  rewriteSignedHlsPlaylist,
} = require("../dist/modules/video-processing/signed-hls-playlist");
const {
  VideoDelivery,
} = require("../dist/modules/video-processing/video-delivery");

const fromCloudFrontBase64 = (value) =>
  Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"),
    "base64",
  );

test("CloudFront signed URL binds one object and expiration to an RSA signature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const url = "https://example.cloudfront.net/groups/g/videos/f/job/hls/seg.ts";
  const expires = Math.floor(Date.now() / 1000) + 900;
  const signed = new URL(
    signCloudFrontUrl(
      url,
      "K309R6IXKZS780",
      privateKey.export({ type: "pkcs8", format: "pem" }),
      expires,
    ),
  );
  const policy = fromCloudFrontBase64(signed.searchParams.get("Policy"));
  const signature = fromCloudFrontBase64(signed.searchParams.get("Signature"));
  assert.equal(signed.searchParams.get("Hash-Algorithm"), "SHA256");
  assert.equal(signed.searchParams.get("Key-Pair-Id"), "K309R6IXKZS780");
  assert.deepEqual(JSON.parse(policy).Statement[0], {
    Resource: url,
    Condition: { DateLessThan: { "AWS:EpochTime": expires } },
  });
  assert.equal(verify("RSA-SHA256", policy, publicKey, signature), true);
});

test("HLS rewrite signs segments and protects every nested playlist", () => {
  const prefix = "groups/g/videos/f/job";
  const master = rewriteSignedHlsPlaylist(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhls/720p.m3u8\n",
    `${prefix}/master.m3u8`,
    prefix,
    (key) => `/api/${key}`,
    (key) => `https://cdn/${key}?Signature=ok`,
  );
  assert.match(master, /\/api\/groups\/g\/videos\/f\/job\/hls\/720p\.m3u8/);
  const variant = rewriteSignedHlsPlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg-1.m4s\n',
    `${prefix}/hls/720p.m3u8`,
    prefix,
    (key) => `/api/${key}`,
    (key) => `https://cdn/${key}?Signature=ok`,
  );
  assert.match(
    variant,
    /URI="https:\/\/cdn\/groups\/g\/videos\/f\/job\/hls\/init\.mp4\?Signature=ok"/,
  );
  assert.match(
    variant,
    /https:\/\/cdn\/groups\/g\/videos\/f\/job\/hls\/seg-1\.m4s\?Signature=ok/,
  );
  assert.throws(() =>
    rewriteSignedHlsPlaylist(
      "#EXTM3U\n../../outside.ts\n",
      `${prefix}/hls/720p.m3u8`,
      prefix,
      () => "",
      () => "",
    ),
  );
});

test("private delivery signs thumbnails, scopes API grants and rejects expired or changed grants", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = {
    auth: {
      accessTokenSecret: "test-only-signing-secret",
      cookie: { secure: false },
    },
    video: {
      mode: "aws",
      region: "ap-northeast-1",
      outputBucket: "output",
      mediaDomain: "example.cloudfront.net",
      cloudFrontKeyPairId: "K309R6IXKZS780",
      cloudFrontSigningSecretId: "unused-test-secret",
    },
  };
  const delivery = new VideoDelivery(config, {
    resolve: async () => ({
      driver: "s3",
      bucket: "output",
      region: "ap-northeast-1",
    }),
  });
  delivery.signingKey = Promise.resolve(
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const output = {
    storageLocationId: "a".repeat(64),
    prefix: "asset/job",
    masterKey: "asset/job/master.m3u8",
  };
  const grant = await delivery.grant("file", "job", output);
  assert.equal(grant.url, "/api/v1/video-media/file/job/master.m3u8");
  assert.ok(
    new URL(grant.assetUrl("asset/job/poster.jpg")).searchParams.has(
      "Signature",
    ),
  );
  assert.throws(() => grant.assetUrl("other/poster.jpg"));
  const token = grant.cookies[0].value;
  assert.equal(delivery.verify(token, "file", "job").prefix, output.prefix);
  assert.throws(() => delivery.verify(token, "other", "job"));
  assert.throws(() => delivery.verify(token + "tamper", "file", "job"));
  const realNow = Date.now;
  try {
    const now = realNow();
    Date.now = () => now + 61000;
    assert.throws(() => delivery.verify(token, "file", "job"));
  } finally {
    Date.now = realNow;
  }
});
