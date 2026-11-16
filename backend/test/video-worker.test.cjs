const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const {
  VideoJobsService,
} = require("../dist/modules/video-processing/video-jobs.service");
const {
  VideoWorker,
} = require("../dist/modules/video-processing/video-worker");

function workerFixture() {
  const service = new VideoJobsService(
    {},
    {
      video: {
        mode: "local",
        workerEnabled: true,
        ffmpegPath: require("@ffmpeg-installer/ffmpeg").path,
        ffprobePath: require("@ffprobe-installer/ffprobe").path,
      },
    },
  );
  let closed = 0;
  const worker = new VideoWorker(service, {}, {}, { close: () => closed++ });
  worker.retention = async () => {};
  return { worker, service, closed: () => closed };
}
async function promptly(work) {
  let timer;
  try {
    await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("worker did not wake promptly")),
          400,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("committed video wakes the local development worker immediately", async () => {
  const f = workerFixture();
  let calls = 0,
    ready,
    processed;
  const idle = new Promise((done) => (ready = done));
  const next = new Promise((done) => (processed = done));
  f.worker.once = async () => {
    if (++calls === 1) ready();
    else processed();
    return false;
  };
  try {
    await f.worker.onApplicationBootstrap();
    await idle;
    await delay(0); // Let the worker enter its interruptible idle wait.
    f.service.notifyQueued();
    await promptly(next);
  } finally {
    await f.worker.onModuleDestroy();
  }
  assert.equal(f.service.listenerCount("queued"), 0);
  assert.equal(f.closed(), 1);
});

test("a notification during a DB scan is retained; shutdown interrupts idle wait", async () => {
  const f = workerFixture();
  let calls = 0,
    scanned;
  const next = new Promise((done) => (scanned = done));
  f.worker.once = async () => {
    if (++calls === 1) f.service.notifyQueued();
    else scanned();
    return false;
  };
  try {
    await f.worker.start();
    await promptly(next);
    await delay(0);
    await promptly(f.worker.onModuleDestroy());
  } finally {
    await f.worker.onModuleDestroy();
  }
});

test("polling recovers a persisted job even when the in-process signal was lost", async () => {
  const f = workerFixture();
  let available = false,
    recovered;
  const next = new Promise((done) => (recovered = done));
  f.worker.once = async () => {
    if (available) {
      recovered();
      available = false;
    }
    return false;
  };
  try {
    await f.worker.start();
    await delay(0);
    available = true; // Simulates a commit in another API replica.
    await Promise.race([
      next,
      delay(2500).then(() => {
        throw new Error("durable job not recovered");
      }),
    ]);
  } finally {
    await f.worker.onModuleDestroy();
  }
});
