import { build } from "esbuild";
import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const folder = resolve(root, "backend/dist/video-lambda");
await mkdir(folder, { recursive: true });
const result = await build({
  entryPoints: [resolve(root, "backend/src/video.lambda.ts")],
  outfile: resolve(folder, "index.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: true,
  metafile: true,
  external: ["@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe"],
  logLevel: "warning",
});
const inputs = Object.keys(result.metafile.inputs);
if (
  inputs.some((file) =>
    /(?:generated[\\/]prisma|node_modules[\\/](?:@prisma|pg[\\/]|pg-pool))/.test(
      file,
    ),
  )
)
  throw new Error(
    "Lambda must not include PostgreSQL or Prisma runtime dependencies.",
  );
await writeFile(
  resolve(folder, "metafile.json"),
  JSON.stringify(result.metafile),
);
const zip = resolve(root, "backend/dist/video-lambda.zip");
const archive = new ZipArchive({ zlib: { level: 9 } });
await new Promise((done, reject) => {
  const output = createWriteStream(zip);
  output.on("close", done);
  output.on("error", reject);
  archive.on("error", reject);
  archive.pipe(output);
  archive.file(resolve(folder, "index.cjs"), { name: "index.cjs" });
  void archive.finalize().catch(reject);
});
console.log(
  `Lambda ZIP: backend/dist/video-lambda.zip (${((await stat(zip)).size / 1024 ** 2).toFixed(1)} MiB), no PostgreSQL/Prisma.`,
);
