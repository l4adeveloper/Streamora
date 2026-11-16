import { createHmac, timingSafeEqual } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  open,
  realpath,
  unlink,
  mkdtemp,
  writeFile,
  rmdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ApiError } from "../../common/api-error";
import { PREVIEW_TYPES, matchesPreviewType } from "./file-preview";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteRange } from "./byte-range";

export function attachmentName(name: string, preview = false) {
  return `${preview ? "inline" : "attachment"}; filename="${preview ? "preview" : "download"}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
export class LocalFileStorage {
  async writeText(key: string, text: string) {
    const directory = await mkdtemp(join(tmpdir(), "streamora-summary-"));
    const source = join(directory, "summary.md");
    try {
      await writeFile(source, text, { flag: "wx" });
      await this.importFile(source, key);
    } finally {
      await unlink(source).catch(() => {});
      await rmdir(directory);
    }
  }
  private readonly root: string;
  private readonly signingKey: Buffer;
  constructor(
    private readonly options: {
      directory: string;
      secret: string;
      ttlSeconds: number;
      baseUrl: string;
      locationId?: string;
    },
  ) {
    this.root = resolve(options.directory);
    this.signingKey = createHmac("sha256", options.secret)
      .update("streamora/local-file-download/v1")
      .digest();
  }
  private path(key: string) {
    // Only server-created portable object keys; never accept OS paths.
    if (
      typeof key !== "string" ||
      key.length > 1024 ||
      !/^[A-Za-z0-9_./-]+$/.test(key) ||
      key
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
        )
    )
      throw new ApiError(
        400,
        "INVALID_OBJECT_KEY",
        "Định danh file không hợp lệ.",
      );
    const path = resolve(this.root, key);
    this.within(path);
    return path;
  }
  private within(path: string) {
    const child = relative(this.root, path);
    if (
      !child ||
      child === ".." ||
      child.startsWith(`..${sep}`) ||
      isAbsolute(child)
    )
      throw new ApiError(
        400,
        "INVALID_OBJECT_KEY",
        "Định danh file không hợp lệ.",
      );
  }
  private async checkedPath(key: string) {
    const path = this.path(key);
    // Protect against a manually placed symlink/junction escaping the storage directory.
    const [root, target] = await Promise.all([
      realpath(this.root),
      realpath(path),
    ]);
    const child = relative(root, target);
    if (
      !child ||
      child === ".." ||
      child.startsWith(`..${sep}`) ||
      isAbsolute(child)
    )
      throw new ApiError(403, "FORBIDDEN", "Không được truy cập file này.");
    return path;
  }
  async importFile(sourcePath: string, key: string) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const [root, parent] = await Promise.all([
      realpath(this.root),
      realpath(dirname(path)),
    ]);
    const child = relative(root, parent);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Không được ghi file tại vị trí này.",
      );
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await copyFile(sourcePath, temporary, constants.COPYFILE_EXCL);
      // Publish a complete file atomically without overwriting an existing object.
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async download(
    key: string,
    name: string,
    now = Date.now(),
    preview = false,
    mimeType = "application/pdf",
  ) {
    this.path(key);
    const expires = now + Math.min(60, this.options.ttlSeconds) * 1000;
    const data = Buffer.from(
      JSON.stringify({
        key,
        name,
        expires,
        ...(this.options.locationId
          ? { locationId: this.options.locationId }
          : {}),
        ...(preview ? { preview: true, previewType: mimeType } : {}),
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", this.signingKey)
      .update(data)
      .digest("base64url");
    return {
      url: `${this.options.baseUrl}/api/v1/file-downloads/local?token=${data}.${signature}`,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  async openDownload(
    token: string,
    now = Date.now(),
    range?: string,
    head = false,
  ) {
    let payload: {
      key: string;
      name: string;
      expires: number;
      preview?: boolean;
      previewType?: string;
    };
    try {
      if (typeof token !== "string" || token.length > 8192) throw new Error();
      const parts = token.split(".");
      if (
        parts.length !== 2 ||
        parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
      )
        throw new Error();
      const expected = createHmac("sha256", this.signingKey)
        .update(parts[0])
        .digest();
      const actual = Buffer.from(parts[1], "base64url");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (
        !Number.isSafeInteger(payload.expires) ||
        now >= payload.expires ||
        typeof payload.key !== "string" ||
        typeof payload.name !== "string" ||
        payload.name.length > 255 ||
        (payload.preview !== undefined &&
          typeof payload.preview !== "boolean") ||
        (payload.previewType !== undefined &&
          (!payload.preview || !PREVIEW_TYPES.has(payload.previewType)))
      )
        throw new Error();
    } catch {
      throw new ApiError(
        403,
        "DOWNLOAD_LINK_INVALID",
        "Liên kết tải không hợp lệ hoặc đã hết hạn.",
      );
    }
    try {
      const handle = await open(await this.checkedPath(payload.key), "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile())
          throw new ApiError(
            404,
            "FILE_NOT_FOUND",
            "Không tìm thấy nội dung file.",
          );
        if (payload.preview) {
          const header = Buffer.alloc(12);
          await handle.read(header, 0, 12, 0);
          if (
            !matchesPreviewType(
              header,
              payload.previewType ?? "application/pdf",
            )
          )
            throw new ApiError(
              415,
              payload.previewType?.startsWith("video/")
                ? "VIDEO_PREVIEW_UNSUPPORTED"
                : payload.previewType?.startsWith("image/")
                  ? "IMAGE_PREVIEW_UNSUPPORTED"
                  : "PDF_PREVIEW_UNSUPPORTED",
              "Nội dung file không khớp định dạng xem trước.",
            );
        }
        const selected =
          range && !head ? byteRange(range, stat.size) : undefined;
        const status = selected === null ? 416 : selected ? 206 : 200;
        const size =
          selected === null
            ? 0
            : selected
              ? selected.end - selected.start + 1
              : stat.size;
        let stream: Readable;
        if (head || selected === null) {
          await handle.close();
          stream = Readable.from([]);
        } else {
          // Own the handle lifetime explicitly, including interrupted range reads.
          stream = handle.createReadStream({
            autoClose: false,
            ...(selected ? { start: selected.start, end: selected.end } : {}),
          });
          let closed = false;
          const release = () => {
            if (closed) return;
            closed = true;
            void handle.close().catch(() => {});
          };
          stream.once("end", release);
          stream.once("error", release);
          stream.once("close", release);
        }
        return {
          stream,
          size,
          status,
          contentRange:
            selected === null
              ? `bytes */${stat.size}`
              : selected
                ? `bytes ${selected.start}-${selected.end}/${stat.size}`
                : undefined,
          disposition: attachmentName(payload.name, payload.preview),
          type: payload.preview
            ? (payload.previewType ?? "application/pdf")
            : "application/octet-stream",
        };
      } catch (error) {
        await handle.close();
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ApiError(
          404,
          "FILE_NOT_FOUND",
          "Không tìm thấy nội dung file.",
        );
      throw error;
    }
  }
  async delete(key: string) {
    try {
      await unlink(await this.checkedPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async size(key: string) {
    try {
      const handle = await open(await this.checkedPath(key), "r");
      try {
        return (await handle.stat()).size;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
