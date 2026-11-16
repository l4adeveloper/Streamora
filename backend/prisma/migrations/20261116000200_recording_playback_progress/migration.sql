CREATE TABLE "recording_playback_progress" (
  "recording_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "position_seconds" DOUBLE PRECISION NOT NULL,
  "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recording_playback_progress_pkey" PRIMARY KEY ("recording_id", "user_id"),
  CONSTRAINT "recording_playback_progress_position_check" CHECK ("position_seconds" >= 0 AND "position_seconds" < 100000000),
  CONSTRAINT "recording_playback_progress_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "class_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recording_playback_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
