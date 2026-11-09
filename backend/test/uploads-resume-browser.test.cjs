const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFile, mkdtemp, rm } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const { chromium } = require("playwright");
const {
  LocalMultipartStorage,
} = require("../dist/modules/uploads/local-multipart-storage");

test(
  "T17 controller in browser: durable metadata, full-content fingerprint, pause, resume missing parts and re-sign on retry",
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "streamora-resume-"));
    const server = createServer((req, res) =>
      res.end("<!doctype html><title>Resume test</title>"),
    );
    let browser, storage;
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      storage = new LocalMultipartStorage({
        directory,
        secret: "test-secret",
        origin,
        port: 0,
      });
      let session,
        fingerprint,
        filename,
        signs = 0,
        created = 0,
        digest;
      const sessions = new Map();
      let testPartSize = 8 * 1024 ** 2;
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage();
      await page.exposeFunction("testApi", async (path, options = {}) => {
        if (path === "/uploads") {
          created++;
          const data = options.body;
          fingerprint = data.fingerprint;
          filename = data.filename;
          const id = await storage.create(
            "groups/test/uploads/test",
            data.size,
            testPartSize,
            Date.now() + 86400000,
          );
          session = {
            uploadId: id,
            partSize: testPartSize,
            totalParts: Math.ceil(data.size / testPartSize),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            size: data.size,
            filename: data.filename,
            fingerprint: data.fingerprint,
          };
          sessions.set(id, session);
          return session;
        }
        const current = sessions.get(path.split("/")[2]);
        if (path.endsWith("/parts/sign")) {
          signs++;
          return {
            parts: await Promise.all(
              options.body.partNumbers.map(async (partNumber) => ({
                partNumber,
                url: await storage.sign(current.uploadId, partNumber, 60),
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              })),
            ),
          };
        }
        if (path.endsWith("/complete")) {
          assert.ok(
            options.body.parts.every(
              (part) =>
                Object.keys(part).sort().join(",") === "etag,partNumber",
            ),
            "Resumed completion must not include ListParts-only fields such as size",
          );
          const actual = await storage.list(current.uploadId);
          await storage.complete(current.uploadId, actual, async (path) => {
            digest = createHash("sha256")
              .update(await readFile(path))
              .digest("hex");
          });
          return { file: { id: "file-id" } };
        }
        return {
          ...current,
          status: "ACTIVE",
          groupId: "group",
          filename: current.filename,
          fingerprint: current.fingerprint,
          uploadedParts: await storage.list(current.uploadId),
        };
      });
      const sources = await Promise.all(
        ["upload-store", "upload"].map(async (name) => {
          const source = await readFile(
            join(__dirname, "../../frontend/src/lib/files", `${name}.ts`),
            "utf8",
          );
          return ts.transpileModule(source, {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2022,
            },
          }).outputText;
        }),
      );
      const install = async () =>
        page.addScriptTag({
          content: `
      window.modules = {};
      window.fileBytesRead = 0;
      const nativeArrayBuffer = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function(...args) { window.fileBytesRead += this.size; return nativeArrayBuffer.apply(this, args); };
      class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
      const require = name => name === 'client-only' ? {} : name === '@/lib/api' ? { apiRequest: window.testApi, ApiError } : name === '@/lib/auth/session' ? { authSession: { getSnapshot: () => ({ user: { id: 'owner' } }) } } : window.modules[name];
      { const exports = {}; ${sources[0]} window.modules['./upload-store'] = exports; }
      { const exports = {}; ${sources[1]} window.uploader = exports; }
    `,
        });
      await page.goto(origin);
      await install();
      let block = true,
        resumed = false,
        refusedOnce = false;
      const sentAfterReload = [];
      await page.route("**/parts?token=*", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        const token = new URL(route.request().url()).searchParams.get("token");
        const part = JSON.parse(
          Buffer.from(token.split(".")[0], "base64url").toString(),
        ).partNumber;
        if (block && part > 5) {
          while ((await storage.list(session.uploadId)).length < 5)
            await new Promise((resolve) => setTimeout(resolve, 10));
          await page.evaluate(() => (window.interrupted = true));
          return route.abort("internetdisconnected");
        }
        if (resumed) {
          sentAfterReload.push(part);
          if (!refusedOnce) {
            refusedOnce = true;
            return route.fulfill({
              status: 403,
              headers: { "Access-Control-Allow-Origin": origin },
            });
          }
        }
        return route.continue();
      });
      await page.evaluate(() => {
        window.file = new File(
          [new Uint8Array(48 * 1024 ** 2 + 33).fill(17)],
          "resume.pdf",
          { type: "application/pdf" },
        );
        window.controller = new AbortController();
        window.pending = window.uploader
          .uploadFile(window.file, "group", {
            signal: window.controller.signal,
            onSession: (s) => (window.session = s),
            onProgress: () => {},
          })
          .catch((error) => error.name);
      });
      await page.waitForFunction(() => window.interrupted);
      await page.evaluate(() => window.controller.abort());
      assert.equal(await page.evaluate(() => window.pending), "AbortError");
      assert.equal((await storage.list(session.uploadId)).length, 5);
      await page.reload();
      await install();
      const rows = await page.evaluate(() =>
        window.modules["./upload-store"].uploadStore.list("owner", "group"),
      );
      assert.equal(rows.length, 1);
      assert.equal(
        (
          await page.evaluate(() =>
            window.modules["./upload-store"].uploadStore.list("other", "group"),
          )
        ).length,
        0,
      );
      const mismatch = await page.evaluate(async (id) => {
        const bytes = new Uint8Array(48 * 1024 ** 2 + 33).fill(17);
        bytes[bytes.length - 1] = 99;
        try {
          await window.uploader.uploadFile(
            new File([bytes], "resume.pdf"),
            "group",
            {
              resumeId: id,
              signal: new AbortController().signal,
              onSession: () => {},
              onProgress: () => {},
            },
          );
        } catch (error) {
          return error.code;
        }
      }, session.uploadId);
      assert.equal(mismatch, "UPLOAD_FILE_MISMATCH");
      block = false;
      resumed = true;
      await page.evaluate(async (id) => {
        window.resumeProgress = [];
        const file = new File(
          [new Uint8Array(48 * 1024 ** 2 + 33).fill(17)],
          "resume.pdf",
          { type: "application/pdf" },
        );
        const upload = await window.uploader.uploadFile(file, "group", {
          resumeId: id,
          signal: new AbortController().signal,
          onSession: () => {},
          onProgress: (percent) => window.resumeProgress.push(percent),
        });
        await upload.complete();
      }, session.uploadId);
      const resumedProgress = await page.evaluate(() => window.resumeProgress);
      assert.equal(
        resumedProgress[0],
        Math.floor(((40 * 1024 ** 2) / (48 * 1024 ** 2 + 33)) * 100),
      );
      assert.equal(created, 1);
      assert.ok(sentAfterReload.length >= 3);
      assert.ok(sentAfterReload.every((number) => number > 5));
      assert.ok(signs >= 3);
      assert.equal(
        digest,
        createHash("sha256")
          .update(Buffer.alloc(48 * 1024 ** 2 + 33, 17))
          .digest("hex"),
      );
      assert.equal(
        (
          await page.evaluate(() =>
            window.modules["./upload-store"].uploadStore.list("owner", "group"),
          )
        ).length,
        0,
      );

      // Reproduce a click during the FIRST batch, while no part is durable yet.
      await page.unroute("**/parts?token=*");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 5,
        downloadThroughput: 100 * 1024 ** 2,
        uploadThroughput: 2 * 1024 ** 2,
      });
      let partsAtPauseRequest;
      await page.exposeFunction("capturePauseCheckpoint", async () => {
        partsAtPauseRequest = (await storage.list(session.uploadId)).length;
      });
      const partialSent = [];
      page.on("request", (request) => {
        if (
          request.method() !== "PUT" ||
          !request.url().includes("/parts?token=")
        )
          return;
        const token = new URL(request.url()).searchParams.get("token");
        partialSent.push(
          JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())
            .partNumber,
        );
      });
      await page.evaluate(() => {
        window.partialFile = new File(
          [new Uint8Array(48 * 1024 ** 2 + 33).fill(23)],
          "partial.pdf",
          { type: "application/pdf" },
        );
        window.partialController = new AbortController();
        window.partialProgress = [];
        window.partialPending = window.uploader
          .uploadFile(window.partialFile, "group", {
            signal: window.partialController.signal,
            runPart: window.uploader.createPartLimiter(1),
            onSession: () => {},
            onProgress: (percent) => {
              window.partialProgress.push(percent);
              if (percent > 0 && !window.partialController.signal.aborted) {
                window.pauseCheckpoint = window.capturePauseCheckpoint();
                window.pauseRequestedAt = performance.now();
                window.partialController.abort();
              }
            },
          })
          .then(
            () => "not-paused",
            (error) => {
              window.pauseSettledAfter =
                performance.now() - window.pauseRequestedAt;
              return error.name;
            },
          );
      });
      assert.equal(
        await page.evaluate(() => window.partialPending),
        "AbortError",
      );
      assert.ok(
        await page.evaluate(() => window.pauseSettledAfter < 1000),
        "Pause must abort without waiting for a full part",
      );
      await page.evaluate(() => window.pauseCheckpoint);
      assert.equal(
        partsAtPauseRequest,
        0,
        "Pause must be requested before any part is complete",
      );
      assert.equal((await storage.list(session.uploadId)).length, 0);
      assert.deepEqual(
        partialSent.slice().sort((a, b) => a - b),
        [1],
      );
      const pausedPercent = await page.evaluate(() =>
        window.partialProgress.at(-1),
      );
      assert.ok(pausedPercent > 0 && pausedPercent < 16);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      const bytesBeforePartialResume = await page.evaluate(
        () => window.fileBytesRead,
      );
      await page.evaluate(async (id) => {
        window.resumedPartialProgress = [];
        const result = await window.uploader.uploadFile(
          window.partialFile,
          "group",
          {
            resumeId: id,
            signal: new AbortController().signal,
            onSession: () => {},
            onProgress: (percent) =>
              window.resumedPartialProgress.push(percent),
          },
        );
        await result.complete();
      }, session.uploadId);
      assert.equal(
        await page.evaluate(() => window.fileBytesRead),
        bytesBeforePartialResume,
        "Same-tab resume must not re-read the File for its fingerprint",
      );
      assert.equal(
        await page.evaluate(() => window.resumedPartialProgress[0]),
        0, // Storage truth: interrupted first part must be retried; UI keeps its visual position.
      );
      assert.deepEqual(
        partialSent.slice(1).sort((a, b) => a - b),
        [1, 2, 3, 4, 5, 6, 7],
      );
      assert.equal(
        digest,
        createHash("sha256")
          .update(Buffer.alloc(48 * 1024 ** 2 + 33, 23))
          .digest("hex"),
      );
      const benchmark = await page.evaluate(async () => {
        const { fingerprintFile } = window.modules["./upload-store"];
        const block = new Blob([new Uint8Array(8 * 1024 ** 2).fill(31)]);
        const large = new File(Array(128).fill(block), "1GiB.bin");
        const initialBytes = window.fileBytesRead;
        let started = performance.now();
        const hash = await fingerprintFile(large, new AbortController().signal);
        const firstMs = performance.now() - started;
        const firstRead = window.fileBytesRead - initialBytes;
        started = performance.now();
        const repeated = await fingerprintFile(
          large,
          new AbortController().signal,
        );
        const cachedMs = performance.now() - started;
        const cachedRead = window.fileBytesRead - initialBytes - firstRead;
        const aborted = new AbortController();
        aborted.abort();
        let abortName;
        try {
          await fingerprintFile(large, aborted.signal);
        } catch (error) {
          abortName = error.name;
        }
        const beforeReselection = window.fileBytesRead;
        const original = new File(
          [new Uint8Array(1024 ** 2).fill(3)],
          "same.bin",
          { lastModified: 1234 },
        );
        const different = new File(
          [new Uint8Array(1024 ** 2).fill(4)],
          "same.bin",
          { lastModified: 1234 },
        );
        const a = await fingerprintFile(original, new AbortController().signal);
        const b = await fingerprintFile(
          different,
          new AbortController().signal,
        );
        return {
          firstMs,
          cachedMs,
          firstRead,
          cachedRead,
          equal: hash === repeated,
          abortName,
          reselectedRead: window.fileBytesRead - beforeReselection,
          differentHash: a !== b,
        };
      });
      assert.equal(benchmark.firstRead, 1024 ** 3);
      assert.equal(benchmark.cachedRead, 0);
      assert.equal(benchmark.equal, true);
      assert.equal(benchmark.abortName, "AbortError");
      assert.equal(benchmark.reselectedRead, 2 * 1024 ** 2);
      assert.equal(benchmark.differentHash, true);
      console.log(
        `1 GiB fingerprint: first ${benchmark.firstMs.toFixed(1)}ms; same File cached ${benchmark.cachedMs.toFixed(1)}ms, 0 bytes re-read`,
      );
      await page.evaluate(async () => {
        const directory = await navigator.storage.getDirectory();
        const handle = await directory.getFileHandle("saved-upload.bin", {
          create: true,
        });
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array(1024 ** 2).fill(42));
        await writer.close();
        await window.modules["./upload-store"].uploadStore.save(
          {
            uploadId: "saved-handle",
            userId: "owner",
            groupId: "group",
            filename: "saved-upload.bin",
            size: 1024 ** 2,
            fingerprint: "test",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
          { handle },
        );
      });
      await page.reload();
      await install();
      const restoredHandle = await page.evaluate(async () => {
        const store = window.modules["./upload-store"].uploadStore;
        const denied = await store.source("saved-handle", "other", "group");
        const source = await store.source("saved-handle", "owner", "group");
        const bytes = new Uint8Array(
          await (await source.handle.getFile()).arrayBuffer(),
        );
        await store.remove("saved-handle");
        return {
          denied: denied === undefined,
          size: bytes.length,
          intact: bytes.every((b) => b === 42),
          removed:
            (await store.source("saved-handle", "owner", "group")) ===
            undefined,
        };
      });
      assert.deepEqual(restoredHandle, {
        denied: true,
        size: 1024 ** 2,
        intact: true,
        removed: true,
      });
      const expiredSource = await page.evaluate(async () => {
        const store = window.modules["./upload-store"].uploadStore;
        await store.save(
          {
            uploadId: "expired-source",
            userId: "owner",
            groupId: "group",
            filename: "expired.bin",
            size: 1,
            fingerprint: "test",
            expiresAt: new Date(0).toISOString(),
          },
          { file: new File([new Uint8Array([1])], "expired.bin") },
        );
        const listed = await store.list("owner", "group");
        return {
          metadataKept: listed.some((row) => row.uploadId === "expired-source"),
          sourceRemoved:
            (await store.source("expired-source", "owner", "group")) ===
            undefined,
        };
      });
      assert.deepEqual(expiredSource, {
        metadataKept: true,
        sourceRemoved: true,
      });
      // After reload a sparse missing set must fill all five PUT slots.
      testPartSize = 64 * 1024;
      const sparse = await page.evaluate(async () => {
        const file = new File(
          [new Uint8Array(25 * 64 * 1024).fill(9)],
          "sparse.pdf",
          { type: "application/pdf" },
        );
        const store = window.modules["./upload-store"];
        const fingerprint = await store.fingerprintFile(
          file,
          new AbortController().signal,
        );
        const session = await window.testApi("/uploads", {
          body: {
            filename: file.name,
            size: file.size,
            mimeType: file.type,
            fingerprint,
          },
        });
        await store.uploadStore.save(
          { ...session, userId: "owner", groupId: "group" },
          { file },
        );
        return session;
      });
      const missing = [1, 6, 11, 16, 21];
      await Promise.all(
        Array.from({ length: 25 }, (_, i) => i + 1)
          .filter((n) => !missing.includes(n))
          .map(async (n) => {
            const url = await storage.sign(sparse.uploadId, n, 60);
            assert.equal(
              (
                await fetch(url, {
                  method: "PUT",
                  body: Buffer.alloc(64 * 1024, 9),
                })
              ).status,
              200,
            );
          }),
      );
      await page.reload();
      await install();
      const outstanding = new Set();
      let peak = 0;
      page.on("request", (request) => {
        if (
          request.method() === "PUT" &&
          request.url().includes("/parts?token=")
        ) {
          outstanding.add(request);
          peak = Math.max(peak, outstanding.size);
        }
      });
      page.on("requestfinished", (request) => outstanding.delete(request));
      page.on("requestfailed", (request) => outstanding.delete(request));
      await page.route("**/parts?token=*", async (route) => {
        if (route.request().method() === "PUT")
          await new Promise((resolve) => setTimeout(resolve, 150));
        await route.continue();
      });
      await page.evaluate(async (id) => {
        const source = await window.modules[
          "./upload-store"
        ].uploadStore.source(id, "owner", "group");
        const result = await window.uploader.uploadFile(source.file, "group", {
          resumeId: id,
          signal: new AbortController().signal,
          onSession: () => {},
          onProgress: () => {},
        });
        await result.complete();
      }, sparse.uploadId);
      assert.equal(
        await page.evaluate(() => window.fileBytesRead),
        0,
        "A durable snapshot must resume after reload without rehashing its contents",
      );
      console.log(
        `Sparse resume: missing [${missing}], peak ${peak} concurrent PUTs`,
      );
      assert.equal(
        peak,
        5,
        "Sparse missing parts must not be serialized by their original part numbers",
      );
      assert.equal(
        digest,
        createHash("sha256")
          .update(Buffer.alloc(25 * 64 * 1024, 9))
          .digest("hex"),
      );
      const draftLifecycle = await page.evaluate(async () => {
        const { uploadStore: store, fingerprintFile } =
          window.modules["./upload-store"];
        const file = new File([new Uint8Array([1, 2, 3])], "draft.pdf", {
          type: "application/pdf",
        });
        const metadata = {
          userId: "owner",
          groupId: "drafts",
          filename: file.name,
          size: file.size,
          fingerprint: "",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          pending: true,
        };
        await store.stage([
          {
            upload: { ...metadata, uploadId: "draft-a", queuedAt: 1 },
            source: { file },
          },
          {
            upload: { ...metadata, uploadId: "draft-b", queuedAt: 2 },
            source: { file },
          },
        ]);
        const initial = await store.list("owner", "drafts");
        const source = await store.source("draft-a", "owner", "drafts");
        const fingerprint = await fingerprintFile(
          source.file,
          new AbortController().signal,
        );
        await store.save(
          {
            ...metadata,
            pending: undefined,
            uploadId: "server-a",
            queuedAt: 1,
            fingerprint,
          },
          { file: source.file },
          "draft-a",
        );
        const promoted = await store.list("owner", "drafts");
        const moved = await store.source("server-a", "owner", "drafts");
        const result = {
          staged: initial.length === 2 && initial.every((row) => row.pending),
          promotedOnce:
            promoted.length === 2 &&
            promoted.some(
              (row) => row.uploadId === "server-a" && !row.pending,
            ) &&
            !promoted.some((row) => row.uploadId === "draft-a"),
          oldSourceRemoved:
            (await store.source("draft-a", "owner", "drafts")) === undefined,
          bytes: [...new Uint8Array(await moved.file.arrayBuffer())],
        };
        await store.remove("draft-b");
        await store.remove("server-a");
        return {
          ...result,
          cleared: (await store.list("owner", "drafts")).length === 0,
        };
      });
      assert.deepEqual(draftLifecycle, {
        staged: true,
        promotedOnce: true,
        oldSourceRemoved: true,
        bytes: [1, 2, 3],
        cleared: true,
      });
    } finally {
      if (browser) await browser.close();
      if (storage) await storage.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
