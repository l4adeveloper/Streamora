const { spawnSync } = require("node:child_process");

function awsCli(region) {
  return (args, missing = []) => {
    const result = spawnSync(
      "aws",
      [...args, "--region", region, "--output", "json", "--no-cli-pager"],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, AWS_CLI_AUTO_PROMPT: "off" },
      },
    );
    if (result.error) throw new Error("Chưa có AWS CLI trong PATH.");
    if (result.status !== 0) {
      if (missing.some((code) => result.stderr.includes(`(${code})`))) return null;
      throw new Error(result.stderr.trim() || `AWS CLI lỗi: ${args[0]} ${args[1]}`);
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  };
}
module.exports = { awsCli };
