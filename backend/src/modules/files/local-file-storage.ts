import { createHmac, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, open, realpath, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ApiError } from "../../common/api-error";

export function attachmentName(name: string, preview = false) {
  return `${preview ? "inline" : "attachment"}; filename="${preview ? "preview.pdf" : "download"}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
export class LocalFileStorage {
  private readonly root: string;
  private readonly signingKey: Buffer;
  constructor(
    private readonly options: {
      directory: string;
      secret: string;
      ttlSeconds: number;
      baseUrl: string;
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
    await copyFile(sourcePath, path, constants.COPYFILE_EXCL);
  }
  async download(key: string, name: string, now = Date.now(), preview = false) {
    this.path(key);
    const expires = now + this.options.ttlSeconds * 1000;
    const data = Buffer.from(
      JSON.stringify({
        key,
        name,
        expires,
        ...(preview ? { preview: true } : {}),
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
  async openDownload(token: string, now = Date.now()) {
    let payload: {
      key: string;
      name: string;
      expires: number;
      preview?: boolean;
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
        (payload.preview !== undefined && typeof payload.preview !== "boolean")
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
          const header = Buffer.alloc(5);
          await handle.read(header, 0, 5, 0);
          if (header.toString("ascii") !== "%PDF-")
            throw new ApiError(
              415,
              "PDF_PREVIEW_UNSUPPORTED",
              "Nội dung file không phải PDF hợp lệ.",
            );
        }
        return {
          stream: handle.createReadStream(),
          size: stat.size,
          disposition: attachmentName(payload.name, payload.preview),
          type: payload.preview
            ? "application/pdf"
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
}
