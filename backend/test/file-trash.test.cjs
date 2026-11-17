const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { Readable, Writable } = require("node:stream");
const { test } = require("node:test");
const {
  FileTrashStorage,
  trashFailureDetails,
} = require("../dist/modules/files/file-trash-storage");
const {
  FileTrashService,
} = require("../dist/modules/files/file-trash.service");

const object = {
  trashBucket: "private-trash",
  trashKey: "trash/archive",
  objectKey: "groups/example/video.mp4",
  storageLocationId: "original-s3",
};

test("archive verifies the bytes before returning the S3 ETag and GCS generation", async () => {
  const body = Buffer.from("restore these bytes");
  const uploaded = [];
  const progress = [];
  const storage = new FileTrashStorage({
    s3: async (location) => {
      assert.equal(location, object.storageLocationId);
      return {
        bucket: "library",
        client: {
          async send(command) {
            assert.equal(command.constructor.name, "GetObjectCommand");
            return {
              Body: Readable.from([body]),
              ContentLength: body.length,
              ETag: '"source-etag"',
            };
          },
        },
      };
    },
  });
  let md5Hash = createHash("md5").update(body).digest("base64");
  storage.gcs = {
    bucket: () => ({
      file: () => ({
        createWriteStream: () =>
          new Writable({
            write(chunk, _, done) {
              uploaded.push(Buffer.from(chunk));
              this.emit("progress", { bytesWritten: chunk.length });
              done();
            },
          }),
        getMetadata: async () => [
          { size: String(body.length), generation: "4217", md5Hash },
        ],
      }),
    }),
  };
  const source = { ...object, size: BigInt(body.length) };
  assert.deepEqual(
    await storage.archive(
      source,
      new AbortController().signal,
      (bytes, total) => progress.push([bytes, total]),
    ),
    {
      generation: "4217",
      etag: '"source-etag"',
    },
  );
  assert.deepEqual(Buffer.concat(uploaded), body);
  assert.deepEqual(progress, [[body.length, body.length]]);
  md5Hash = "incorrect";
  await assert.rejects(
    storage.archive(source, new AbortController().signal),
    (error) => {
      assert.deepEqual(trashFailureDetails(error), {
        step: "VERIFY_GCS",
        code: "TRASH_COPY_MISMATCH",
      });
      return true;
    },
  );
});

test("archive diagnostics preserve AWS and Google errors without logging request details", async () => {
  const storage = new FileTrashStorage({
    s3: async () => ({
      client: {
        async send() {
          throw Object.assign(new Error("message includes a signed URL"), {
            name: "PermanentRedirect",
            $metadata: { httpStatusCode: 301 },
            $response: { headers: { "x-amz-bucket-region": "ap-northeast-1" } },
          });
        },
      },
    }),
  });
  await assert.rejects(
    storage.archive({ ...object, size: 1n }, new AbortController().signal),
    (error) => {
      assert.deepEqual(trashFailureDetails(error), {
        step: "READ_S3",
        code: "PermanentRedirect",
        httpStatus: 301,
        bucketRegion: "ap-northeast-1",
      });
      return true;
    },
  );
  assert.deepEqual(
    trashFailureDetails({ code: 403, message: "private request" }),
    {
      code: "HTTP_403",
      httpStatus: 403,
    },
  );
  assert.deepEqual(
    trashFailureDetails({
      response: {
        status: 400,
        data: { error: "invalid_grant", token: "discard" },
      },
    }),
    {
      code: "invalid_grant",
      httpStatus: 400,
    },
  );
});

test("multipart restore completes only after the archived stream has passed validation", async () => {
  const partSize = 16 * 1024 ** 2;
  const parts = [Buffer.alloc(partSize, 1), Buffer.from([2, 3])];
  const size = partSize + 2;
  const calls = [];
  let failValidation = true;
  const storage = new FileTrashStorage({
    s3: async () => ({
      bucket: "library",
      client: {
        async send(command) {
          const name = command.constructor.name;
          calls.push(name);
          if (name === "CreateMultipartUploadCommand")
            return { UploadId: "upload" };
          if (name === "UploadPartCommand") {
            const part = command.input.PartNumber;
            assert.deepEqual(command.input.Body, parts[part - 1]);
            return { ETag: `"${part}"`, ChecksumCRC32: "test" };
          }
          return {};
        },
      },
    }),
  });
  storage.gcs = {
    bucket: () => ({
      file: (_, { generation }) => {
        assert.equal(generation, "4217");
        return {
          getMetadata: async () => [
            { size: String(size), crc32c: "test", contentType: "video/mp4" },
          ],
          createReadStream: () =>
            Readable.from(
              (async function* () {
                yield* parts;
                if (failValidation)
                  throw new Error("CONTENT_DOWNLOAD_MISMATCH");
              })(),
            ),
        };
      },
    }),
  };
  const source = { ...object, size: BigInt(size) };
  await assert.rejects(
    storage.restore(source, "4217", new AbortController().signal),
    /CONTENT_DOWNLOAD_MISMATCH/,
  );
  assert.ok(calls.includes("AbortMultipartUploadCommand"));
  assert.ok(!calls.includes("CompleteMultipartUploadCommand"));

  failValidation = false;
  calls.length = 0;
  const progress = [];
  await storage.restore(
    source,
    "4217",
    new AbortController().signal,
    (bytes, total) => progress.push([bytes, total]),
  );
  assert.deepEqual(progress[0], [partSize, size * 2]);
  assert.deepEqual(progress.at(-1), [size * 2, size * 2]);
  assert.deepEqual(calls, [
    "CreateMultipartUploadCommand",
    "UploadPartCommand",
    "UploadPartCommand",
    "CompleteMultipartUploadCommand",
  ]);
});

test("worker keeps each source until the destination checkpoint and republishes the same file", async () => {
  const fileId = randomUUID();
  const job = {
    ...object,
    fileId,
    file: { size: 42n },
    attempts: 1,
    trashPhase: "ARCHIVING",
  };
  const events = [];
  const db = {
    $queryRaw: async () => [{ file_id: fileId }],
    fileObjectDeletion: {
      findFirst: async () => job,
      updateMany: async ({ data }) => {
        Object.assign(job, data);
        return { count: 1 };
      },
      deleteMany: async () => {
        events.push("remove job");
        return { count: 1 };
      },
    },
    libraryFile: {
      update: async ({ where, data }) => {
        assert.equal(where.id, fileId);
        assert.deepEqual(data, { status: "AVAILABLE", deletedAt: null });
        events.push("republish");
        return { classRecording: null };
      },
    },
    storageReplica: { updateMany: async () => {} },
    $transaction: async (callback) => callback(db),
  };
  const worker = new FileTrashService(db, {}, {}, {});
  worker.storage = {
    archive: async (object, _signal, report) => {
      report(21, Number(object.size));
      assert.equal(job.trashProgressPercent, 50);
      events.push("copy to GCS");
      return { generation: "4217", etag: '"source"' };
    },
    removeOriginal: async (_, etag) => {
      assert.equal(etag, '"source"');
      events.push("remove S3");
    },
    restore: async (object, generation, _signal, report) => {
      assert.equal(generation, "4217");
      report(84, Number(object.size) * 2);
      assert.equal(job.trashProgressPercent, 99);
      events.push("copy to S3");
    },
    removeArchive: async (_, generation) => {
      assert.equal(generation, "4217");
      events.push("remove GCS");
    },
  };
  await worker.tick();
  assert.equal(job.trashPhase, "ARCHIVED");
  assert.equal(job.trashProgressPercent, 99);
  assert.deepEqual(events, ["copy to GCS"]);
  await worker.tick();
  assert.equal(job.trashPhase, "TRASHED");
  assert.equal(job.trashProgressPercent, 100);
  job.trashPhase = "RESTORING";
  await worker.tick();
  assert.equal(job.trashPhase, "RESTORED");
  assert.deepEqual(events, ["copy to GCS", "remove S3", "copy to S3"]);
  await worker.tick();
  assert.deepEqual(events, [
    "copy to GCS",
    "remove S3",
    "copy to S3",
    "remove GCS",
    "remove job",
    "republish",
  ]);
});
