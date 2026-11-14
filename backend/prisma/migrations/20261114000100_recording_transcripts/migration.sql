CREATE TYPE "RecordingTranscriptStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'TOO_LONG');

ALTER TABLE "class_recordings"
  ADD COLUMN "transcript_status" "RecordingTranscriptStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "transcript_next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "transcript_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "transcript_cues" JSONB;

CREATE INDEX "class_recordings_transcript_queue_idx"
  ON "class_recordings" ("status", "transcript_status", "transcript_next_attempt_at");
