import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { VideoError } from "./video-policy";
const LIMIT = 8 * 1024 ** 3;
export async function prepareScratch(
  directory: string,
  estimatedBytes: number,
) {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !/^[a-f0-9-]{36}-[A-Za-z0-9]{6}$/.test(entry.name)
    )
      continue;
    const path = resolve(root, entry.name),
      physical = await realpath(path),
      child = relative(root, physical);
    if (
      !child ||
      child === ".." ||
      child.startsWith(`..${sep}`) ||
      physical !== path
    )
      continue;
    // Encoding times out after four hours; only abandoned scratch older than a day is removed.
    if ((await stat(path)).mtimeMs < Date.now() - 86400000)
      await rm(path, { recursive: true, force: true });
  }
  let bytes = 0,
    entries = 0;
  async function count(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 100000) throw new VideoError("SCRATCH_LIMIT_EXCEEDED");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await count(path);
      else if (entry.isFile()) bytes += (await stat(path)).size;
      if (bytes + estimatedBytes > LIMIT)
        throw new VideoError("SCRATCH_LIMIT_EXCEEDED");
    }
  }
  await count(root);
  if (bytes + estimatedBytes > LIMIT)
    throw new VideoError("SCRATCH_LIMIT_EXCEEDED");
}
