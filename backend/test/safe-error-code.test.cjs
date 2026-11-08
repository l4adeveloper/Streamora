const assert = require("node:assert/strict");
const { test } = require("node:test");
const { safeErrorCode } = require("../dist/common/safe-error-code");
test("diagnostics classify driver failures without disclosing raw errors or credentials", () => {
  assert.equal(
    safeErrorCode(new Error("Query read timeout")),
    "DATABASE_QUERY_TIMEOUT",
  );
  assert.equal(
    safeErrorCode(new Error("timeout exceeded when trying to connect")),
    "CONNECTION_TIMEOUT",
  );
  assert.equal(
    safeErrorCode({
      meta: { driverAdapterError: { cause: { originalCode: "42501" } } },
      code: "P2010",
    }),
    "42501",
  );
  for (const code of [
    "postgres://private:secret@db/app",
    "SECRET\nMESSAGE",
    "x".repeat(100),
  ])
    assert.equal(safeErrorCode({ code, message: "secret" }), "UNKNOWN");
});
