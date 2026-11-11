CREATE TYPE "ClassMediaSource" AS ENUM ('CAMERA', 'SCREEN');

ALTER TABLE "class_media_connections"
  ADD COLUMN "source" "ClassMediaSource" NOT NULL DEFAULT 'CAMERA',
  ADD CONSTRAINT "class_media_connections_participation_client_source_key"
    UNIQUE ("participation_id", "client_id", "source"),
  DROP CONSTRAINT "class_media_connections_participation_id_client_id_key";
