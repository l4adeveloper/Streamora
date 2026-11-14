const { randomUUID } = require("node:crypto");
const {
  loadEnvironmentFile,
  readEnvironment,
} = require("../dist/config/environment");
const { VIDEO_TYPES } = require("../dist/modules/files/video-playback.service");
const { safeErrorCode } = require("../dist/common/safe-error-code");
const { PrismaService } = require("../dist/database/prisma.service");
const {
  StorageLocationsService,
} = require("../dist/modules/files/storage-locations.service");
const {
  FileStorageService,
} = require("../dist/modules/files/file-storage.service");
const {
  transcribeRecording,
} = require("../dist/modules/class-recordings/azure-speech-transcriber");

async function testS3(config, uri, region) {
  const match = /^s3:\/\/([a-z0-9.-]{3,63})\/(.+)$/.exec(uri ?? "");
  if (!match || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region ?? "")) {
    throw Object.assign(new Error(), { code: "INVALID_S3_TEST_ARGUMENTS" });
  }
  if (!config.azureSpeech) {
    throw Object.assign(new Error(), { code: "AZURE_SPEECH_NOT_CONFIGURED" });
  }

  const [, bucket, objectKey] = match;
  const storage = new FileStorageService({
    ...config,
    files: { ...config.files, driver: "s3", bucket, region },
  });
  try {
    const cues = await transcribeRecording(
      config.azureSpeech,
      storage,
      { objectKey, storageLocationId: null },
      AbortSignal.timeout(135 * 60_000),
    );
    console.log(`Transcription completed. Caption cues: ${cues.length}.`);
    if (cues.length === 0) console.log("Azure returned no caption text.");
  } finally {
    storage.onModuleDestroy();
  }
}

async function main() {
  const [command, id, ...extra] = process.argv.slice(2);
  const action =
    command === "status-file"
      ? "status"
      : command === "retry-file"
        ? "retry"
        : command;
  const byFile = action !== command;
  if (action === "test-s3" && extra.length === 1) {
    loadEnvironmentFile();
    return testS3(readEnvironment(), id, extra[0]);
  }
  if (
    !(
      (action === "find-s3" &&
        /^s3:\/\/[a-z0-9.-]{3,63}\/.+$/.test(id ?? "")) ||
      (["status", "retry", "queue-file"].includes(action) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id ?? ""))
    ) ||
    extra.length
  ) {
    console.error(
      "Usage: node backend/scripts/recording-transcript.cjs <status|retry> <recording-id>\n" +
        "       node backend/scripts/recording-transcript.cjs find-s3 <s3-uri>\n" +
        "       node backend/scripts/recording-transcript.cjs <status-file|retry-file|queue-file> <file-id>\n" +
        "       node backend/scripts/recording-transcript.cjs test-s3 <s3-uri> <aws-region>",
    );
    process.exitCode = 1;
    return;
  }

  loadEnvironmentFile();
  const config = readEnvironment();
  const db = new PrismaService(config.databaseUrl);
  try {
    if (action === "queue-file") {
      if (!config.azureSpeech) {
        console.error(
          "Set AZURE_SPEECH_REGION and AZURE_SPEECH_KEY before queueing.",
        );
        process.exitCode = 1;
        return;
      }
      const queued = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM files WHERE id = ${id}::uuid FOR UPDATE`;
        const file = await tx.libraryFile.findUnique({
          where: { id },
          select: {
            status: true,
            source: true,
            mimeType: true,
            createdBy: true,
            groupId: true,
            sessionId: true,
            createdAt: true,
            session: { select: { groupId: true } },
            classRecording: { select: { id: true } },
          },
        });
        if (
          !file ||
          file.status !== "AVAILABLE" ||
          !VIDEO_TYPES.has(file.mimeType)
        )
          return null;
        let recording = file.classRecording;
        if (file.source === "LOCAL_RECORDING" && !recording) {
          if (!file.sessionId || file.session?.groupId !== file.groupId)
            return null;
          recording = await tx.classRecording.create({
            data: {
              id: randomUUID(),
              fileId: id,
              status: "SAVED",
              sessionId: file.sessionId,
              recorderId: file.createdBy,
              // The original capture times are unknown. Use the file's saved time.
              startedAt: file.createdAt,
              stoppedAt: file.createdAt,
            },
            select: { id: true },
          });
        }
        if (file.source !== "DOCUMENT" && !recording) return null;
        const transcript = await tx.videoTranscript.upsert({
          where: { fileId: id },
          create: { fileId: id },
          update: {},
          select: { transcriptStatus: true },
        });
        return { id: recording?.id ?? id, fileId: id, ...transcript };
      });
      if (queued) console.log(queued);
      else {
        console.error(
          "Queueing requires an available library video or a classroom video linked to its session.",
        );
        process.exitCode = 1;
      }
      return;
    }
    if (action === "find-s3") {
      const [, bucket, objectKey] = /^s3:\/\/([^/]+)\/(.+)$/.exec(id);
      const file = await db.libraryFile.findUnique({
        where: { objectKey },
        select: {
          id: true,
          name: true,
          mimeType: true,
          source: true,
          status: true,
          storageLocationId: true,
          classRecording: {
            select: {
              id: true,
              status: true,
            },
          },
          videoTranscript: {
            select: { transcriptStatus: true, transcriptAttempts: true },
          },
        },
      });
      if (file) {
        const location = await new StorageLocationsService(config, db).resolve(
          file.storageLocationId,
        );
        if (location.driver === "s3" && location.bucket === bucket) {
          const { classRecording, videoTranscript, ...details } = file;
          console.dir({
            ...details,
            classRecording: classRecording
              ? { ...classRecording, ...videoTranscript }
              : null,
            transcript: videoTranscript,
          });
          return;
        }
      }
      console.error(
        "No Streamora file is registered at that S3 bucket and key.",
      );
      process.exitCode = 1;
      return;
    }
    const recording = byFile
      ? null
      : await db.classRecording.findUnique({
          where: { id },
          select: { fileId: true, status: true },
        });
    const fileId = byFile ? id : recording?.fileId;
    if (!fileId) {
      console.error("No video is linked to that recording ID.");
      process.exitCode = 1;
      return;
    }
    if (action === "retry") {
      if (!config.azureSpeech) {
        console.error(
          "Set AZURE_SPEECH_REGION and AZURE_SPEECH_KEY before retrying.",
        );
        process.exitCode = 1;
        return;
      }
      const { count } = await db.videoTranscript.updateMany({
        where: {
          fileId,
          transcriptStatus: "FAILED",
          file: { status: "AVAILABLE" },
        },
        data: {
          transcriptStatus: "PENDING",
          transcriptAttempts: 0,
          transcriptNextAttemptAt: new Date(),
        },
      });
      if (count) {
        console.log(`Video ${fileId} queued for transcription.`);
        return;
      }
      console.error(
        "Retry applies to available videos with transcript status FAILED.",
      );
      process.exitCode = 1;
      return;
    }

    const row = await db.videoTranscript.findUnique({
      where: { fileId },
      select: {
        transcriptStatus: true,
        transcriptAttempts: true,
        transcriptNextAttemptAt: true,
        file: {
          select: { id: true, objectKey: true, storageLocationId: true },
        },
      },
    });
    if (!row) {
      const file = await db.libraryFile.findUnique({
        where: { id: fileId },
        select: {
          id: true,
          name: true,
          status: true,
          source: true,
          mimeType: true,
          sessionId: true,
        },
      });
      if (!file) {
        console.error("No Streamora library file has that ID in this database.");
        console.error("Use find-s3 <s3-uri> to look up the library file ID.");
      } else {
        console.log({ file });
        console.error("No transcript job found for this video.");
        if (file.status !== "AVAILABLE") {
          console.error("Transcription requires an AVAILABLE file.");
        } else if (!VIDEO_TYPES.has(file.mimeType)) {
          console.error(`Supported video types: ${[...VIDEO_TYPES].join(", ")}.`);
        } else if (file.source === "DOCUMENT") {
          console.error(
            `Run node backend/scripts/recording-transcript.cjs queue-file ${fileId} to create a job for this upload.`,
          );
        }
      }
      process.exitCode = 1;
      return;
    }
    console.log({ ...(recording && { status: recording.status }), ...row });
    const location = await new StorageLocationsService(config, db).resolve(
      row.file.storageLocationId,
    );
    if (location.driver === "s3")
      console.log({
        bucket: location.bucket,
        region: location.region,
        key: row.file.objectKey,
      });
    else console.log({ storageDriver: location.driver });
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    `Recording transcript command failed (${safeErrorCode(error)}).`,
  );
  process.exitCode = 1;
});
