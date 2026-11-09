const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const { setImmediate: tick } = require("node:timers/promises");
const ts = require("typescript");

const source = ts.transpileModule(
  readFileSync(
    join(__dirname, "../../frontend/src/lib/files/upload.ts"),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Run the real upload controller with controllable transport, without disk/network timing noise.
function fixture({ partSize = 4, send, sign } = {}) {
  const sessions = new Map(),
    signed = [],
    completed = new Map();
  let active = 0,
    peak = 0;
  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  const apiRequest = async (path, options) => {
    if (path === "/uploads") {
      const body = options.body;
      const session = {
        uploadId: body.filename,
        partSize,
        totalParts: Math.ceil(body.size / partSize),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        received: new Map(),
      };
      sessions.set(session.uploadId, session);
      return session;
    }
    const id = path.split("/")[2],
      session = sessions.get(id);
    if (path.endsWith("/parts/sign")) {
      const numbers = options.body.partNumbers;
      signed.push({ id, numbers });
      if (sign) await sign({ id, numbers, ApiError });
      return {
        parts: numbers.map((partNumber) => ({
          partNumber,
          url: `http://storage.test/${id}/${partNumber}`,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        })),
      };
    }
    if (path.endsWith("/complete")) {
      const parts = options.body.parts;
      assert.equal(parts.length, session.totalParts);
      const bytes = await Promise.all(
        [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => session.received.get(part.partNumber).arrayBuffer()),
      );
      completed.set(
        id,
        Buffer.concat(bytes.map((value) => Buffer.from(value))),
      );
      return { file: { id } };
    }
    throw new Error(`Unexpected API call: ${path}`);
  };
  class XHR {
    upload = {};
    open(method, url) {
      this.url = new URL(url);
    }
    getResponseHeader() {
      return '"test-etag"';
    }
    send(body) {
      active++;
      peak = Math.max(peak, active);
      const [, id, number] = this.url.pathname.split("/");
      let finished = false;
      this.finish = (status = 200) => {
        if (finished) return;
        finished = true;
        active--;
        this.status = status;
        if (status === 200) sessions.get(id).received.set(Number(number), body);
        this.onload();
      };
      this.abort = () => {
        if (finished) return;
        finished = true;
        active--;
        this.onabort();
      };
      if (send) send({ id, partNumber: Number(number), finish: this.finish });
      else queueMicrotask(() => this.finish());
    }
  }
  const exports = {};
  runInNewContext(source, {
    exports,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    XMLHttpRequest: XHR,
    require: (name) => {
      if (name === "client-only") return {};
      if (name === "@/lib/api") return { apiRequest, ApiError };
      if (name === "@/lib/auth/session")
        return {
          authSession: { getSnapshot: () => ({ user: { id: "owner" } }) },
        };
      if (name === "./upload-store")
        return {
          fingerprintFile: async () => "test-fingerprint",
          uploadStore: { save: async () => {}, remove: async () => {} },
        };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return {
    ...exports,
    signed,
    completed,
    get peak() {
      return peak;
    },
    async upload(name, bytes, runPart, signal = new AbortController().signal) {
      const result = await exports.uploadFile(
        new File([bytes], name, { type: "application/pdf" }),
        "group",
        {
          signal,
          runPart,
          onSession: () => {},
          onProgress: () => {},
        },
      );
      await result.complete();
    },
  };
}

test("Ready files share all five PUT slots; a late file gets the next free slot", async () => {
  const { createPartLimiter } = fixture();
  const run = createPartLimiter(5),
    gate = deferred(),
    started = [];
  let active = 0,
    peak = 0;
  const jobs = ["A", "B", "C", "D"].flatMap((id) =>
    Array.from({ length: 5 }, () =>
      run(async () => {
        started.push(id);
        peak = Math.max(peak, ++active);
        await gate.promise;
        active--;
      }, id),
    ),
  );
  await tick();
  assert.equal(started.length, 5);
  assert.equal(
    new Set(started).size,
    4,
    "Every ready file must receive a slot before one file takes all five",
  );
  gate.resolve();
  await Promise.all(jobs);
  assert.equal(peak, 5);

  const releases = [],
    order = [],
    single = createPartLimiter(1);
  const first = single(async () => {
    order.push("A");
    await new Promise((resolve) => releases.push(resolve));
  }, "A");
  await tick();
  const later = ["A", "B", "C", "D"].flatMap((id) =>
    Array.from({ length: 3 }, () =>
      single(async () => {
        order.push(id);
      }, id),
    ),
  );
  releases[0]();
  await Promise.all([first, ...later]);
  assert.deepEqual(order.slice(0, 5), ["A", "B", "C", "D", "A"]);
});

test("Pausing queued parts rejects immediately without waiting for another file's PUT", async () => {
  const { createPartLimiter } = fixture();
  const run = createPartLimiter(1),
    gate = deferred(),
    controller = new AbortController();
  const first = run(() => gate.promise, "active");
  await tick();
  const stopped = run(
    async () => assert.fail("Paused part must never send"),
    "paused",
    controller.signal,
  );
  const rejected = assert.rejects(stopped, { name: "AbortError" });
  controller.abort();
  await rejected;
  let progressed = false;
  const following = run(async () => {
    progressed = true;
  }, "next");
  gate.resolve();
  await Promise.all([first, following]);
  assert.equal(progressed, true);
});

test("A failed file yields its PUT slot during retry backoff; both files complete intact", async () => {
  const events = [],
    failed = deferred();
  let rejectOnce = true;
  const uploader = fixture({
    send: ({ id, finish }) => {
      events.push(id);
      queueMicrotask(() => {
        if (id === "A.pdf" && rejectOnce) {
          rejectOnce = false;
          finish(503);
          failed.resolve();
        } else finish();
      });
    },
  });
  const run = uploader.createPartLimiter(1);
  const a = uploader.upload("A.pdf", Buffer.from([1, 2, 3, 4]), run);
  await failed.promise;
  const b = uploader.upload("B.pdf", Buffer.from([5, 6, 7, 8]), run);
  await Promise.all([a, b]);
  assert.deepEqual(events, ["A.pdf", "B.pdf", "A.pdf"]);
  assert.equal(uploader.peak, 1);
  assert.deepEqual(uploader.completed.get("A.pdf"), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(uploader.completed.get("B.pdf"), Buffer.from([5, 6, 7, 8]));
  assert.equal(
    uploader.signed.filter((call) => call.id === "A.pdf").length,
    2,
    "Retry must re-sign its URL",
  );
});

test("Sign one batch ahead while all five PUTs are busy, without duplicate signatures or changed bytes", async () => {
  const held = [],
    firstBatchBusy = deferred();
  let released = false;
  const uploader = fixture({
    send: ({ finish }) => {
      if (!released) {
        held.push(finish);
        if (held.length === 5) firstBatchBusy.resolve();
      } else queueMicrotask(finish);
    },
  });
  const bytes = Buffer.from(Array.from({ length: 48 }, (_, i) => i));
  const pending = uploader.upload(
    "prefetch.pdf",
    bytes,
    uploader.createPartLimiter(5),
  );
  await firstBatchBusy.promise;
  assert.deepEqual(
    uploader.signed.map((call) => Array.from(call.numbers)),
    [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ],
  );
  released = true;
  held.forEach((finish) => finish());
  await pending;
  assert.deepEqual(
    uploader.signed.map((call) => Array.from(call.numbers)),
    [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
      [11, 12],
    ],
  );
  assert.equal(uploader.peak, 5);
  assert.deepEqual(uploader.completed.get("prefetch.pdf"), bytes);
});

test("Pausing with a failed speculative signature produces no dangling work", async () => {
  const busy = deferred(),
    controller = new AbortController();
  let puts = 0;
  const uploader = fixture({
    sign: ({ numbers, ApiError }) => {
      if (numbers[0] === 6)
        throw new ApiError(403, "FORBIDDEN", "Access revoked");
    },
    send: () => {
      if (++puts === 5) busy.resolve();
    },
  });
  const pending = uploader.upload(
    "pause.pdf",
    Buffer.alloc(48),
    uploader.createPartLimiter(5),
    controller.signal,
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await busy.promise;
  await tick(); // The speculative rejection has arrived while the first batch is still transferring.
  controller.abort();
  await rejected;
  assert.equal(puts, 5);
});
