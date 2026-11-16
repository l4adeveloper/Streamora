const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createMeetingFixture } = require("../meeting-fixture.cjs");
const { IvsService } = require("../../dist/modules/class-media/ivs.service");
const {
  FileStorageService,
} = require("../../dist/modules/files/file-storage.service");
const {
  CloudRecordingWorker,
} = require("../../dist/modules/class-recordings/cloud-recording.worker");

test(
  "upgrading the old recording schema restores Record and screen sharing and preserves old recordings",
  { timeout: 120000 },
  async () => {
    const f = await createMeetingFixture();
    try {
      const db = f.prisma;
      const owner = await f.account("Recording upgrade owner");
      const group = await db.group.create({
        data: { name: "Upgrade", ownerId: owner.id },
      });
      const session = await db.classSession.create({
        data: {
          kind: "GROUP",
          groupId: group.id,
          createdById: owner.id,
          title: "Upgrade recording",
          joinCode: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
          status: "LIVE",
          scheduledAt: new Date(),
          startedAt: new Date(),
        },
      });
      const visit = await db.classParticipation.create({
        data: { sessionId: session.id, userId: owner.id },
      });
      const file = await db.libraryFile.create({
        data: {
          groupId: group.id,
          sessionId: session.id,
          createdBy: owner.id,
          name: "Old recording.mp4",
          objectKey: `legacy/${randomUUID()}.mp4`,
          size: 100n,
          mimeType: "video/mp4",
          source: "LOCAL_RECORDING",
          status: "AVAILABLE",
        },
      });
      const legacy = await db.classRecording.create({
        data: {
          id: randomUUID(),
          sessionId: session.id,
          recorderId: owner.id,
          status: "SAVED",
          fileId: file.id,
          stoppedAt: new Date(),
        },
      });
      const stageArn = `arn:aws:ivs:ap-northeast-1:123456789012:stage/${session.id}`;
      await db.classMediaRoom.create({
        data: { sessionId: session.id, state: "READY", stageArn },
      });
      // Provider calls are stubbed: this test never reads .env or connects to AWS.
      f.config.ivs = {
        enabled: true,
        region: "ap-northeast-1",
        tokenTtlSeconds: 60,
        workerEnabled: false,
        recording: { storageArn: "storage", encoderArn: "encoder" },
      };
      f.app.get(IvsService).token = async () => ({
        token: "upgrade-test-token",
        participantId: randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
      });
      f.app.get(CloudRecordingWorker).wake = () => {};
      const storage = f.app.get(FileStorageService);
      storage.locations.target = {
        driver: "s3",
        bucket: "test-recordings",
        region: "ap-northeast-1",
      };

      // Recreate the pre-IVS schema in this disposable database only.
      await db.$executeRawUnsafe(`ALTER TABLE class_recordings
      DROP COLUMN provider, DROP COLUMN stage_arn, DROP COLUMN composition_arn,
      DROP COLUMN recording_prefix, DROP COLUMN storage_location_id, DROP COLUMN next_check_at,
      DROP COLUMN worker_lease_until, DROP COLUMN worker_lease_owner, DROP COLUMN error_code`);
      const root = `/sessions/${session.id}`;
      const screen = {
        participationId: visit.id,
        clientId: randomUUID(),
        requestId: randomUUID(),
        source: "SCREEN",
      };
      for (const [method, path, body] of [
        ["GET", `${root}/recording`],
        ["POST", `${root}/recordings`, { participationId: visit.id }],
        ["POST", `${root}/join`, screen],
      ]) {
        const response = await f.api(owner, method, path, body);
        assert.equal(response.status, 503, JSON.stringify(response.body));
        assert.equal(response.body.error.code, "DATABASE_SCHEMA_OUTDATED");
      }
      const migration = readFileSync(
        resolve(
          __dirname,
          "../../prisma/migrations/20261116000100_ivs_cloud_recordings/migration.sql",
        ),
        "utf8",
      );
      for (const sql of migration.split(";").filter((sql) => sql.trim()))
        await db.$executeRawUnsafe(sql);

      const preserved = await db.classRecording.findUniqueOrThrow({
        where: { id: legacy.id },
      });
      assert.equal(preserved.provider, "BROWSER");
      assert.equal(preserved.status, "SAVED");
      assert.equal(preserved.fileId, file.id);
      const state = await f.api(owner, "GET", `${root}/recording`);
      assert.equal(state.status, 200, JSON.stringify(state.body));
      assert.equal(
        state.body.recording,
        null,
        "Opening the meeting does not start recording",
      );
      const shared = await f.api(owner, "POST", `${root}/join`, screen);
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      const started = await f.api(owner, "POST", `${root}/recordings`, {
        participationId: visit.id,
      });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(started.body.recording.status, "RECORDING");
      const stopped = await f.api(
        owner,
        "POST",
        `${root}/recordings/${started.body.recording.id}/stop`,
        {},
      );
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      assert.equal(stopped.body.recording.status, "SAVING");
      const ended = await f.api(owner, "POST", `${root}/end`, {}, randomUUID());
      assert.equal(ended.status, 200, JSON.stringify(ended.body));
      assert.equal(ended.body.session.status, "ENDED");
    } finally {
      await f.cleanup();
    }
  },
);
