ALTER TABLE "class_media_connections" ADD COLUMN "activated_at" TIMESTAMPTZ(3);

CREATE TABLE "class_recordings" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "recorder_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'RECORDING',
  "camera_position" VARCHAR(12) NOT NULL DEFAULT 'bottom-right',
  "camera_visible" BOOLEAN NOT NULL DEFAULT true,
  "file_id" UUID,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stopped_at" TIMESTAMPTZ(3),
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "class_recordings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_recordings_status_check"
    CHECK ("status" IN ('RECORDING', 'SAVING', 'SAVED', 'FAILED')),
  CONSTRAINT "class_recordings_camera_position_check"
    CHECK ("camera_position" IN ('top-left', 'top-right', 'bottom-left', 'bottom-right')),
  CONSTRAINT "class_recordings_file_saved_check"
    CHECK (("file_id" IS NULL) = ("status" <> 'SAVED')),
  CONSTRAINT "class_recordings_session_id_fkey" FOREIGN KEY ("session_id")
    REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_recordings_recorder_id_fkey" FOREIGN KEY ("recorder_id")
    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_recordings_file_id_fkey" FOREIGN KEY ("file_id")
    REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "class_recordings_file_id_key" ON "class_recordings"("file_id");
CREATE INDEX "class_recordings_session_id_started_at_idx"
  ON "class_recordings"("session_id", "started_at" DESC);
-- One recording at a time per session; finished rows stay as history.
CREATE UNIQUE INDEX "class_recordings_one_active_key" ON "class_recordings"("session_id")
  WHERE "status" = 'RECORDING';

ALTER TABLE class_session_changes DROP CONSTRAINT class_session_changes_kind_check;
ALTER TABLE class_session_changes ADD CONSTRAINT class_session_changes_kind_check
  CHECK (kind IN ('session.changed', 'session.ended', 'queue.changed', 'admission.changed',
    'participants.changed', 'access.changed', 'meeting.created', 'moderation.mute', 'moderation.changed',
    'moderation.banned', 'poll.updated', 'recording.changed'));
