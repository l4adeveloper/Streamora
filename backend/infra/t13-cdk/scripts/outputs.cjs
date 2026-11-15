const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { base } = require("../lib/config.cjs");
function readOutputs(stackName) {
  const result = JSON.parse(
    readFileSync(resolve(base, "cdk.outputs.json"), "utf8"),
  )[stackName];
  if (!result?.SigningSecretArn || !result?.MediaDomain)
    throw new Error("Chưa có outputs đúng stack. Chạy deploy trước.");
  return result;
}
module.exports = { readOutputs };
