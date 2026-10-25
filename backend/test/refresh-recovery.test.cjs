const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomBytes, randomUUID } = require("node:crypto");
const {
  sealRefreshToken,
  openRefreshToken,
} = require("../dist/modules/auth/refresh-recovery");

test("refresh recovery ciphertext is authenticated and bound to its session and server key", () => {
  const token = randomBytes(32).toString("base64url");
  const secret = randomBytes(48).toString("base64url");
  const sid = randomUUID();
  const sealed = sealRefreshToken(token, secret, sid);
  assert.equal(openRefreshToken(sealed, secret, sid), token);
  assert.equal(openRefreshToken(sealed, secret, randomUUID()), null);
  assert.equal(openRefreshToken(sealed, secret + "other-key", sid), null);
  for (const offset of [0, 12, 28, 70]) {
    const tampered = Buffer.from(sealed, "base64url");
    tampered[offset] ^= 1;
    assert.equal(
      openRefreshToken(tampered.toString("base64url"), secret, sid),
      null,
    );
  }
  assert.equal(openRefreshToken("", secret, sid), null);
  assert.equal(openRefreshToken(sealed.slice(0, 20), secret, sid), null);
});
