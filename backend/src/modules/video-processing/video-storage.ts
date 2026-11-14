import { Injectable } from "@nestjs/common";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "node:fs";
import { realpath, stat, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { StorageLocationsService } from "../files/storage-locations.service";
import { byteRange } from "../files/byte-range";
import { objectKey, VideoError } from "./video-policy";

@Injectable()
export class VideoStorage {
  constructor(readonly locations: StorageLocationsService) {}
  async localPath(location: string, key: string, prefix?: string) {
    objectKey(key);
    const target = await this.locations.resolve(location);
    if (target.driver !== "local") throw new VideoError("STORAGE_FAILED");
    const [root, path] = await Promise.all([
      realpath(target.directory),
      realpath(resolve(target.directory, key)),
    ]);
    const child = relative(root, path);
    if (
      !child ||
      child === ".." ||
      child.startsWith(`..${sep}`) ||
      isAbsolute(child)
    )
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    if (prefix) {
      objectKey(prefix);
      const boundary = resolve(root, prefix),
        physical = await realpath(boundary);
      const compare = (value: string) =>
        process.platform === "win32" ? value.toLowerCase() : value;
      const child = relative(physical, path);
      if (
        compare(boundary) !== compare(physical) ||
        !child ||
        child === ".." ||
        child.startsWith(`..${sep}`) ||
        isAbsolute(child)
      )
        throw new VideoError("VIDEO_OUTPUT_INVALID");
    }
    return path;
  }
  async input(location: string, key: string) {
    objectKey(key);
    const target = await this.locations.resolve(location);
    if (target.driver === "local") return this.localPath(location, key);
    const client = new S3Client({ region: target.region });
    try {
      // ffprobe receives only a backend-signed URL for a registered S3 source.
      return await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: target.bucket, Key: key }),
        { expiresIn: 3600 },
      );
    } finally {
      client.destroy();
    }
  }
  async text(location: string, key: string) {
    const stream = (await this.open(location, key)).stream;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 2 * 1024 ** 2) throw new VideoError("VIDEO_OUTPUT_INVALID");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      stream.destroy();
    }
  }
  async list(location: string, prefix: string): Promise<Set<string>> {
    objectKey(prefix);
    const target = await this.locations.resolve(location);
    if (target.driver === "local") throw new VideoError("STORAGE_FAILED");
    const client = new S3Client({ region: target.region });
    const keys = new Set<string>();
    let token: string | undefined;
    try {
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: target.bucket,
            Prefix: prefix + "/",
            ContinuationToken: token,
          }),
        );
        for (const item of page.Contents ?? [])
          if (item.Key && item.Size) keys.add(item.Key);
        if (keys.size > 200000) throw new VideoError("VIDEO_OUTPUT_INVALID");
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !token) throw new VideoError("STORAGE_FAILED");
      } while (token);
      return keys;
    } finally {
      client.destroy();
    }
  }
  async exists(location: string, key: string, listed?: Set<string>) {
    if (listed) return listed.has(key);
    try {
      return (await stat(await this.localPath(location, key))).size > 0;
    } catch {
      return false;
    }
  }
  async removePrefix(location: string, prefix: string) {
    objectKey(prefix);
    // Cleanup is limited to a server-generated transcode job, never an imported IVS tree.
    if (
      !/^groups\/[a-f0-9-]{36}\/videos\/[a-f0-9-]{36}\/[a-f0-9-]{36}(?:\/[1-9]\d*)?$/.test(
        prefix,
      )
    )
      throw new VideoError("VIDEO_OUTPUT_INVALID");
    const target = await this.locations.resolve(location);
    if (target.driver === "local") {
      let path: string;
      try {
        path = await this.localPath(location, prefix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      // localPath resolves symlinks and verifies the absolute target remains in this registered root.
      await rm(path, { recursive: true, force: true });
      return;
    }
    const keys = [...(await this.list(location, prefix))];
    const client = new S3Client({ region: target.region });
    try {
      for (let i = 0; i < keys.length; i += 1000) {
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: target.bucket,
            Delete: {
              Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
        if (result.Errors?.length) throw new VideoError("STORAGE_FAILED");
      }
    } finally {
      client.destroy();
    }
  }
  async open(
    location: string,
    key: string,
    range?: string,
    head = false,
    prefix?: string,
  ) {
    objectKey(key);
    const target = await this.locations.resolve(location);
    if (target.driver === "local") {
      const path = await this.localPath(location, key, prefix),
        info = await stat(path);
      const part = range ? byteRange(range, info.size) : undefined;
      const status = part === null ? 416 : part ? 206 : 200;
      return {
        status,
        size: part === null ? 0 : part ? part.end - part.start + 1 : info.size,
        contentRange:
          part === null
            ? `bytes */${info.size}`
            : part
              ? `bytes ${part.start}-${part.end}/${info.size}`
              : undefined,
        stream:
          head || part === null
            ? Readable.from([])
            : createReadStream(path, part ?? {}),
      };
    }
    // Cloud playback uses CloudFront/OAC. This read path is worker-only metadata I/O.
    const client = new S3Client({ region: target.region });
    try {
      const out = await client.send(
        new GetObjectCommand({ Bucket: target.bucket, Key: key }),
      );
      const stream = out.Body as Readable;
      stream.once("close", () => client.destroy());
      return {
        status: 200,
        size: out.ContentLength ?? 0,
        contentRange: undefined,
        stream,
      };
    } catch (error) {
      client.destroy();
      throw error;
    }
  }
}
