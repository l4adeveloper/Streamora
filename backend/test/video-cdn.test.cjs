const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, verify } = require("node:crypto");
const {
  CloudFrontVideoCdn,
} = require("../dist/modules/video-processing/cloudfront-video-cdn");
const {
  VideoDelivery,
} = require("../dist/modules/video-processing/video-delivery");
const config = {
  video: { outputBucket: "output-bucket", region: "ap-northeast-1" },
};
test("CloudFront signing covers exactly one output tree and unconfigured storage never becomes public", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const video = { ...config.video, mediaDomain: "media.example.com" };
  const provider = new CloudFrontVideoCdn(video);
  provider.secret = {
    keyPairId: "public-key",
    privateKey: keys.privateKey,
    expires: Date.now() + 60000,
  };
  const output = {
    storageLocationId: "a".repeat(64),
    prefix: "groups/g/videos/f/job/1",
    masterKey: "groups/g/videos/f/job/1/hls/master.m3u8",
  };
  const grant = await provider.grant(
    "file",
    output,
    Math.floor(Date.now() / 1000) + 60,
  );
  const decode = (text) =>
    Buffer.from(
      text.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"),
      "base64",
    );
  const policy = decode(
    grant.cookies.find((c) => c.name === "CloudFront-Policy").value,
  );
  const signature = decode(
    grant.cookies.find((c) => c.name === "CloudFront-Signature").value,
  );
  assert.ok(verify("RSA-SHA1", policy, keys.publicKey, signature));
  assert.equal(
    JSON.parse(policy).Statement[0].Resource,
    `https://media.example.com/${output.prefix}/*`,
  );
  assert.equal(grant.cookies.length, 3);
  assert.ok(
    grant.cookies.every(
      (c) => c.secure && c.path === "/" + output.prefix + "/",
    ),
  );
  assert.throws(() => grant.assetUrl("groups/other/master.m3u8"));
  const delivery = new VideoDelivery(
    { video },
    {
      resolve: async () => ({
        driver: "s3",
        bucket: "unmapped",
        region: video.region,
      }),
    },
    [provider],
  );
  await assert.rejects(
    delivery.grant("file", "job", output),
    (error) =>
      error.getStatus() === 503 &&
      error.getResponse().error.code === "VIDEO_DELIVERY_UNAVAILABLE",
  );
});

test("another CDN adapter can own asset URLs without changing the catalog or encoder", async () => {
  const target = { driver: "s3", bucket: "replica", region: "other-region" };
  const adapter = {
    supports: (source) => source.bucket === "replica",
    grant: async () => ({
      url: "https://replica.example/master.m3u8",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      cookies: [],
      assetUrl: (key) => `https://replica.example/${key}?token=temporary`,
    }),
  };
  const delivery = new VideoDelivery(
    { video: config.video },
    { resolve: async () => target },
    [adapter],
  );
  const result = await delivery.grant("file", "job", {
    storageLocationId: "a".repeat(64),
    prefix: "asset",
    masterKey: "asset/master.m3u8",
  });
  assert.equal(
    result.assetUrl("asset/segment.ts"),
    "https://replica.example/asset/segment.ts?token=temporary",
  );
});
