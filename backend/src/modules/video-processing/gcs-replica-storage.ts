import { Storage } from "@google-cloud/storage";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VideoError } from "./video-policy";

// Uses Application Default Credentials. Never stores credentials in replica metadata.
export class GcsReplicaStorage {
  private readonly gcs: Storage;
  constructor(projectId?: string) {
    this.gcs = new Storage({ projectId });
  }
  async text(bucket: string, key: string) {
    const stream = this.gcs.bucket(bucket).file(key).createReadStream();
    const timeout = setTimeout(
      () => stream.destroy(new VideoError("STORAGE_TIMEOUT")),
      10000,
    );
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
      clearTimeout(timeout);
      stream.destroy();
    }
  }
  async copy(
    client: S3Client,
    sourceBucket: string,
    key: string,
    destinationBucket: string,
    version: string,
    signal: AbortSignal,
    destinationKey = key,
    reuse = false,
    expectedSize?: number,
  ) {
    const response = await client.send(
      new GetObjectCommand({ Bucket: sourceBucket, Key: key }),
      { abortSignal: signal },
    );
    if (!response.Body || response.ContentLength === undefined)
      throw new VideoError("SOURCE_NOT_READY");
    if (expectedSize !== undefined && response.ContentLength !== expectedSize) {
      (response.Body as Readable).destroy();
      throw new VideoError("SOURCE_VERSION_CHANGED");
    }
    const file = this.gcs.bucket(destinationBucket).file(destinationKey);
    if (reuse && response.ETag) {
      try {
        const [metadata] = await file.getMetadata();
        if (
          metadata.metadata?.sourceVersion === version &&
          metadata.metadata?.sourceEtag === response.ETag &&
          Number(metadata.size) === response.ContentLength &&
          metadata.md5Hash
        ) {
          (response.Body as Readable).destroy();
          return;
        }
        // Live segments are immutable once a snapshot references them.
        // Never overwrite bytes still used by a previously issued manifest.
        throw new VideoError("SOURCE_VERSION_CHANGED");
      } catch (error) {
        if ((error as { code?: number }).code !== 404) {
          (response.Body as Readable).destroy();
          throw error;
        }
      }
    }
    const hash = createHash("md5");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      response.Body as Readable,
      meter,
      file.createWriteStream({
        resumable: true,
        validation: "crc32c",
        metadata: {
          contentType: response.ContentType ?? "application/octet-stream",
          cacheControl: "private, max-age=0",
          metadata: {
            sourceVersion: version,
            ...(response.ETag ? { sourceEtag: response.ETag } : {}),
          },
        },
      }),
      { signal },
    );
    const [metadata] = await file.getMetadata();
    if (
      bytes !== response.ContentLength ||
      Number(metadata.size) !== bytes ||
      metadata.md5Hash !== hash.digest("base64")
    )
      throw new VideoError("CHECKSUM_MISMATCH");
  }
  async playlist(bucket: string, key: string, text: string, version: string) {
    const file = this.gcs.bucket(bucket).file(key);
    await file.save(text, {
      validation: "crc32c",
      resumable: false,
      metadata: {
        contentType: "application/vnd.apple.mpegurl",
        cacheControl: "private, no-store",
        metadata: { sourceVersion: version },
      },
    });
    const [metadata] = await file.getMetadata();
    if (metadata.md5Hash !== createHash("md5").update(text).digest("base64"))
      throw new VideoError("CHECKSUM_MISMATCH");
  }
}
