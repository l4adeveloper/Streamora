import { build } from "esbuild";
import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const folder = resolve(root, "backend/dist/video-lambda");
await mkdir(folder, { recursive: true });
await build({
  entryPoints: [resolve(root, "backend/dist/video.lambda.js")],
  outfile: resolve(folder, "index.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: true,
  // pg-native is optional; the deployed runtime uses the JS PostgreSQL driver + WASM Prisma.
  external: [
    "pg-native",
    "@ffmpeg-installer/ffmpeg",
    "@ffprobe-installer/ffprobe",
  ],
  logLevel: "warning",
});
const zip = resolve(root, "backend/dist/video-lambda.zip");
const archive = new ZipArchive({ zlib: { level: 9 } });
await new Promise((resolveDone, reject) => {
  const output = createWriteStream(zip);
  output.on("close", resolveDone);
  output.on("error", reject);
  archive.on("error", reject);
  archive.pipe(output);
  // An allowlist prevents .env, credentials, local binaries and unrelated API code from entering the ZIP.
  archive.file(resolve(folder, "index.cjs"), { name: "index.cjs" });
  void archive.finalize().catch(reject);
});
console.log(
  `Lambda ZIP: backend/dist/video-lambda.zip (${((await stat(zip)).size / 1024 ** 2).toFixed(1)} MiB)`,
);
console.log(
  "Upload ZIP in the Lambda Console; runtime Node.js 22.x; handler index.handler. No automatic AWS changes.",
);
