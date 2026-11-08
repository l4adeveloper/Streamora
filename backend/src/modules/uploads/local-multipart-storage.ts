import {
  createHmac,
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  rm,
  rename,
  open,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../../common/api-error";

type Manifest = {
  key: string;
  size: number;
  partSize: number;
  expires: number;
};
export type StoredPart = { partNumber: number; etag: string; size: number };

// A separate HTTP listener simulates object storage. Nest only handles metadata.
export class LocalMultipartStorage {
  private server?: Server;
  private starting?: Promise<void>;
  private baseUrl = "";
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly options: {
      directory: string;
      secret: string;
      origin: string;
      port: number;
    },
  ) {}
  private directory(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Invalid storage upload id");
    return resolve(this.options.directory, id);
  }
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.locks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
  async create(
    key: string,
    size: number,
    partSize: number,
    expires: number,
    id: string = randomUUID(),
  ) {
    await mkdir(this.directory(id), { recursive: true });
    await writeFile(
      join(this.directory(id), "manifest.json"),
      JSON.stringify({ key, size, partSize, expires }),
    );
    return id;
  }
  private async manifest(id: string): Promise<Manifest> {
    return JSON.parse(
      await readFile(join(this.directory(id), "manifest.json"), "utf8"),
    );
  }
  private async start() {
    if (!this.starting)
      this.starting = new Promise<void>((accept, reject) => {
        this.server = createServer((req, res) => {
          void this.put(req, res);
        });
        this.server.once("error", reject);
        this.server.listen(this.options.port, "127.0.0.1", () => {
          const address = this.server!.address();
          this.baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : this.options.port}`;
          accept();
        });
      });
    await this.starting;
  }
  private signature(data: string) {
    return createHmac("sha256", this.options.secret)
      .update(`streamora/upload/v1:${data}`)
      .digest();
  }
  async sign(id: string, partNumber: number, seconds: number) {
    await this.start();
    const data = Buffer.from(
      JSON.stringify({
        id,
        partNumber,
        expires: Date.now() + Math.min(60, seconds) * 1000,
      }),
    ).toString("base64url");
    return `${this.baseUrl}/parts?token=${data}.${this.signature(data).toString("base64url")}`;
  }
  private async put(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.origin === this.options.origin) {
      res.setHeader("Access-Control-Allow-Origin", this.options.origin);
      res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Expose-Headers", "ETag");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    let temporary: string | undefined;
    try {
      if (req.method !== "PUT") throw new Error();
      const url = new URL(req.url!, "http://local");
      if (url.pathname !== "/parts") throw new Error();
      const token = url.searchParams.get("token") ?? "";
      if (token.length > 2048) throw new Error();
      const pieces = token.split(".");
      const actual = Buffer.from(pieces[1] ?? "", "base64url");
      const expected = this.signature(pieces[0]);
      if (
        pieces.length !== 2 ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const { id, partNumber, expires } = JSON.parse(
        Buffer.from(pieces[0], "base64url").toString(),
      );
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        !Number.isFinite(expires) ||
        expires <= Date.now()
      )
        throw new Error();
      {
        const manifest = await this.manifest(id);
        if (manifest.expires <= Date.now()) throw new Error();
        const expectedSize = Math.min(
          manifest.partSize,
          manifest.size - (partNumber - 1) * manifest.partSize,
        );
        if (expectedSize <= 0) throw new Error();
        temporary = join(this.directory(id), `${randomUUID()}.tmp`);
        const hash = createHash("md5");
        let bytes = 0;
        const limit = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > expectedSize) {
              callback(new Error("Part too large"));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          req,
          limit,
          createWriteStream(temporary, { flags: "wx" }),
        );
        if (bytes !== expectedSize) throw new Error("Part size mismatch");
        await this.exclusive(id, async () => {
          await this.manifest(id); // Abort/complete may have closed the session during streaming.
          await rename(
            temporary!,
            join(this.directory(id), `${partNumber}.part`),
          );
        });
        temporary = undefined;
        res.setHeader("ETag", `"${hash.digest("hex")}"`);
        res.writeHead(200).end();
      }
    } catch {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      if (!res.destroyed)
        res.writeHead(403).end("Upload part invalid or expired");
    }
  }
  private async parts(id: string): Promise<StoredPart[]> {
    const entries = await readdir(this.directory(id));
    const result: StoredPart[] = [];
    for (const name of entries.filter((name) => /^\d+\.part$/.test(name))) {
      const path = join(this.directory(id), name);
      const hash = createHash("md5");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      result.push({
        partNumber: parseInt(name),
        etag: `"${hash.digest("hex")}"`,
        size: (await stat(path)).size,
      });
    }
    return result.sort((a, b) => a.partNumber - b.partNumber);
  }
  list(id: string) {
    return this.exclusive(id, () => this.parts(id));
  }
  async complete(
    id: string,
    expected: StoredPart[],
    publish: (path: string) => Promise<void>,
  ) {
    return this.exclusive(id, async () => {
      const actual = await this.parts(id);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new ApiError(
          409,
          "MISSING_PARTS",
          "Các phần tải lên đã thay đổi.",
        );
      const target = join(this.directory(id), "assembled");
      const handle = await open(target, "w");
      try {
        for (const part of actual) {
          for await (const chunk of createReadStream(
            join(this.directory(id), `${part.partNumber}.part`),
          )) {
            // FileHandle.write can be partial; writeFile handles the complete buffer.
            await handle.writeFile(chunk);
          }
        }
      } finally {
        await handle.close();
      }
      await publish(target);
      await rm(join(this.directory(id), "manifest.json"), { force: true });
      // Keep parts until DB commit. Retry is recovered from the published object.
    });
  }
  abort(id: string) {
    return this.exclusive(id, () =>
      rm(this.directory(id), { recursive: true, force: true }),
    );
  }
  async close() {
    if (this.server?.listening)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
