const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  CloudFrontVideoCdn,
} = require("../dist/modules/video-processing/cloudfront-video-cdn");
const {
  VideoDelivery,
} = require("../dist/modules/video-processing/video-delivery");
const config = {
  video: { mode: "aws", outputBucket: "output-bucket", region: "ap-northeast-1" },
};
test("CloudFront serves public output without cookies and rejects unmapped storage", async () => {
  const video = { ...config.video, mediaDomain: "media.example.com" };
  const provider = new CloudFrontVideoCdn(video);
  const output = { storageLocationId: "a".repeat(64), prefix: "groups/g/videos/f/job/1", masterKey: "groups/g/videos/f/job/1/hls/master.m3u8" };
  const grant = await provider.grant("file", output, Math.floor(Date.now() / 1000) + 60);
  assert.equal(grant.url, "https://media.example.com/" + output.masterKey);
  assert.deepEqual(grant.cookies, []);
  assert.equal(grant.public, true);
  assert.equal(grant.grantUrl, undefined);
  assert.equal(grant.assetUrl(output.prefix + "/hls/segment.ts"), "https://media.example.com/" + output.prefix + "/hls/segment.ts");
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
