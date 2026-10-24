const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { resolve, join, dirname, basename } = require("node:path");
const { parseEnv } = require("node:util");

test("setup keeps existing files, generates the signing secret and leaves DATABASE_URL to fill in", async () => {
  const { setupEnvironment } = await import("../scripts/setup-env.mjs");
  const root = await mkdtemp(join(tmpdir(), "streamora-env-setup-"));
  const source = resolve(__dirname, "../..");
  try {
    for (const path of ["backend/.env.example", "frontend/.env.example"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await copyFile(join(source, path), join(root, path));
    }
    const first = await setupEnvironment(root);
    assert.ok(first.every((file) => file.status === "created"));
    const files = ["backend/.env", "frontend/.env.local"];
    const contents = await Promise.all(
      files.map((path) => readFile(join(root, path), "utf8")),
    );
    const backend = parseEnv(contents[0]);
    assert.match(backend.DATABASE_URL, /^postgresql:\/\/replace-with-/);
    assert.ok(!("POSTGRES_PASSWORD" in backend));
    assert.ok(
      Buffer.from(backend.ACCESS_TOKEN_SECRET, "base64url").length >= 32,
    );
    assert.match(contents[1], /4000\/api\/v1/);
    assert.ok(!contents[1].includes("SECRET"));
    await writeFile(
      join(root, files[0]),
      `${contents[0]}\n# user customization\n`,
    );
    const second = await setupEnvironment(root);
    assert.ok(second.every((file) => file.status === "preserved"));
    assert.equal(
      await readFile(join(root, files[0]), "utf8"),
      `${contents[0]}\n# user customization\n`,
    );
    assert.equal(await readFile(join(root, files[1]), "utf8"), contents[1]);
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("streamora-env-setup-"));
    await rm(root, { recursive: true, force: true });
  }
});
