CREATE TABLE "upload_sessions" (
  "id" UUID PRIMARY KEY,
  "group_id" UUID NOT NULL REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "filename" VARCHAR(255) NOT NULL,
  "size" BIGINT NOT NULL CHECK (size > 0),
  "mime_type" VARCHAR(255) NOT NULL,
  "fingerprint" VARCHAR(200) NOT NULL,
  "source" "file_source" NOT NULL CHECK (source IN ('DOCUMENT', 'LOCAL_RECORDING')),
  "session_id" UUID REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "object_key" VARCHAR(1024) NOT NULL UNIQUE,
  "storage_id" TEXT NOT NULL,
  "driver" VARCHAR(10) NOT NULL CHECK (driver IN ('local', 's3')),
  "part_size" INTEGER NOT NULL CHECK (part_size > 0),
  "total_parts" INTEGER NOT NULL CHECK (total_parts BETWEEN 1 AND 10000),
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED', 'ABORTED')),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "file_id" UUID UNIQUE REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((status = 'COMPLETED') = (file_id IS NOT NULL))
);
CREATE INDEX "upload_sessions_status_expires_at_idx" ON "upload_sessions"("status", "expires_at");
