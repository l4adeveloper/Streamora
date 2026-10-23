BEGIN;
CREATE TABLE "class_session_end_consumers" (
  "name" VARCHAR(100) PRIMARY KEY,
  "last_version" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "class_session_end_consumers_name_check" CHECK ("name" ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  CONSTRAINT "class_session_end_consumers_version_check" CHECK ("last_version" >= 0)
);
COMMIT;
