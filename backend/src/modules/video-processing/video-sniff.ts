import type { Readable } from "node:stream";
export async function sniffVideo(input: Readable) {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of input) {
      chunks.push(Buffer.from(chunk).subarray(0, 64 - length));
      length += chunks.at(-1)!.length;
      if (length >= 16) break;
    }
    const header = Buffer.concat(chunks);
    if (header.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
    if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
      return "video/webm";
    return undefined;
  } finally {
    input.destroy();
  }
}
