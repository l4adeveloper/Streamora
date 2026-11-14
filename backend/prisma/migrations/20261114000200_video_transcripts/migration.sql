BEGIN;

CREATE TABLE "video_transcripts" (
  "file_id" UUID NOT NULL,
  "transcript_status" "RecordingTranscriptStatus" NOT NULL DEFAULT 'PENDING',
  "transcript_next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transcript_attempts" INTEGER NOT NULL DEFAULT 0,
  "transcript_cues" JSONB,
  CONSTRAINT "video_transcripts_pkey" PRIMARY KEY ("file_id"),
  CONSTRAINT "video_transcripts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "video_transcripts" ("file_id", "transcript_status", "transcript_next_attempt_at", "transcript_attempts", "transcript_cues")
SELECT "file_id",
  CASE WHEN "transcript_status" = 'PROCESSING' THEN 'PENDING'::"RecordingTranscriptStatus" ELSE "transcript_status" END,
  CASE WHEN "transcript_status" = 'PROCESSING' THEN CURRENT_TIMESTAMP ELSE "transcript_next_attempt_at" END,
  CASE WHEN "transcript_status" = 'PROCESSING' THEN GREATEST(0, "transcript_attempts" - 1) ELSE "transcript_attempts" END,
  "transcript_cues"
FROM "class_recordings"
WHERE "status" = 'SAVED' AND "file_id" IS NOT NULL;

INSERT INTO "video_transcripts" ("file_id")
SELECT "id" FROM "files"
WHERE "source" = 'DOCUMENT' AND "status" = 'AVAILABLE'
  AND "mime_type" IN ('video/mp4', 'video/webm', 'video/quicktime')
ON CONFLICT ("file_id") DO NOTHING;

CREATE INDEX "video_transcripts_queue_idx" ON "video_transcripts" ("transcript_status", "transcript_next_attempt_at");

DROP INDEX "class_recordings_transcript_queue_idx";
ALTER TABLE "class_recordings"
  DROP COLUMN "transcript_status",
  DROP COLUMN "transcript_next_attempt_at",
  DROP COLUMN "transcript_attempts",
  DROP COLUMN "transcript_cues";

COMMIT;
