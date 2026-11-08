export const PREVIEW_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export function matchesPreviewType(header: Buffer, type: string) {
  if (type === "application/pdf")
    return header.subarray(0, 5).toString("ascii") === "%PDF-";
  if (type === "image/jpeg")
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (type === "image/png")
    return header
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/webp")
    return (
      header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP"
    );
  if (type === "video/mp4" || type === "video/quicktime")
    return (
      header.subarray(4, 8).toString("ascii") === "ftyp" ||
      (type === "video/quicktime" &&
        ["moov", "mdat", "wide"].includes(
          header.subarray(4, 8).toString("ascii"),
        ))
    );
  if (type === "video/webm")
    return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}
