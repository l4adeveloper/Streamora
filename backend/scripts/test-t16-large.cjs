const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const result = spawnSync(process.execPath, ["--test", resolve(__dirname, "../test/integration/uploads.test.cjs")], {
  env: { ...process.env, T16_LARGE: "1" }, stdio: "inherit",
});
process.exit(result.status ?? 1);
