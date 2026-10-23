BEGIN;
CREATE TABLE "class_session_commands" (
  "user_id" UUID NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "body_hash" CHAR(64) NOT NULL,
  "session_id" UUID NOT NULL,
  "response" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "class_session_commands_pkey" PRIMARY KEY ("user_id", "operation", "key"),
  CONSTRAINT "class_session_commands_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_session_commands_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_session_commands_key_check" CHECK ("key" ~ '^[!-~]{1,128}$'),
  CONSTRAINT "class_session_commands_operation_check" CHECK ("operation" IN ('CREATE_GROUP', 'CREATE_MEET', 'START', 'END', 'CANCEL')),
  CONSTRAINT "class_session_commands_hash_check" CHECK ("body_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "class_session_commands_response_check" CHECK (jsonb_typeof("response") = 'object')
);
CREATE INDEX "class_session_commands_session_id_idx" ON "class_session_commands" ("session_id");

CREATE TABLE "class_session_end_events" (
  "version" BIGSERIAL PRIMARY KEY,
  "event_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "ended_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "class_session_end_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "class_session_end_events_event_id_key" ON "class_session_end_events" ("event_id");
CREATE UNIQUE INDEX "class_session_end_events_session_id_key" ON "class_session_end_events" ("session_id");
COMMIT;
