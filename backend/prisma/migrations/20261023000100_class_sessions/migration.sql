BEGIN;

CREATE TYPE "class_session_kind" AS ENUM ('GROUP', 'MEET');
CREATE TYPE "class_session_status" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED');
CREATE TYPE "class_join_request_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REVOKED');
CREATE TYPE "class_participation_leave_reason" AS ENUM ('LEFT', 'DISCONNECTED', 'SESSION_ENDED', 'ACCESS_REVOKED');

CREATE TABLE "class_sessions" (
  "id" UUID NOT NULL,
  "kind" "class_session_kind" NOT NULL,
  "group_id" UUID,
  "created_by_id" UUID NOT NULL,
  "title" VARCHAR(100) NOT NULL,
  "description" VARCHAR(2000),
  "join_code" VARCHAR(12) NOT NULL,
  "scheduled_at" TIMESTAMPTZ(3),
  "status" "class_session_status" NOT NULL DEFAULT 'SCHEDULED',
  "started_at" TIMESTAMPTZ(3),
  "ended_at" TIMESTAMPTZ(3),
  "cancelled_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "class_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_sessions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_sessions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_sessions_kind_check" CHECK (
    ("kind" = 'GROUP' AND "group_id" IS NOT NULL AND "scheduled_at" IS NOT NULL)
    OR ("kind" = 'MEET' AND "group_id" IS NULL)
  ),
  CONSTRAINT "class_sessions_title_check" CHECK (length(btrim("title")) > 0),
  CONSTRAINT "class_sessions_join_code_check" CHECK ("join_code" ~ '^[A-Z0-9]{12}$'),
  CONSTRAINT "class_sessions_lifecycle_check" CHECK (
    ("status" = 'SCHEDULED' AND "started_at" IS NULL AND "ended_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'LIVE' AND "started_at" IS NOT NULL AND "ended_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'ENDED' AND "started_at" IS NOT NULL AND "ended_at" IS NOT NULL AND "ended_at" >= "started_at" AND "cancelled_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "started_at" IS NULL AND "ended_at" IS NULL AND "cancelled_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "class_sessions_join_code_key" ON "class_sessions" ("join_code");
CREATE INDEX "class_sessions_group_schedule_idx" ON "class_sessions" ("group_id", "scheduled_at", "id");
CREATE INDEX "class_sessions_group_status_schedule_idx" ON "class_sessions" ("group_id", "status", "scheduled_at", "id");
CREATE INDEX "class_sessions_creator_kind_created_idx" ON "class_sessions" ("created_by_id", "kind", "created_at", "id");

CREATE TABLE "class_join_requests" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "status" "class_join_request_status" NOT NULL DEFAULT 'PENDING',
  "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMPTZ(3),
  "decided_by_id" UUID,
  "closed_at" TIMESTAMPTZ(3),
  CONSTRAINT "class_join_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_join_requests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_join_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_join_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_join_requests_decision_pair_check" CHECK (("decided_at" IS NULL) = ("decided_by_id" IS NULL)),
  CONSTRAINT "class_join_requests_status_check" CHECK (
    ("status" = 'PENDING' AND "decided_at" IS NULL AND "closed_at" IS NULL)
    OR ("status" = 'ACCEPTED' AND "decided_at" IS NOT NULL AND "closed_at" IS NULL)
    OR ("status" = 'REJECTED' AND "decided_at" IS NOT NULL AND "closed_at" IS NOT NULL)
    OR ("status" = 'CANCELLED' AND "decided_at" IS NULL AND "closed_at" IS NOT NULL)
    OR ("status" IN ('EXPIRED', 'REVOKED') AND "closed_at" IS NOT NULL)
  ),
  CONSTRAINT "class_join_requests_time_check" CHECK (
    ("decided_at" IS NULL OR "decided_at" >= "requested_at")
    AND ("closed_at" IS NULL OR "closed_at" >= "requested_at")
    AND ("closed_at" IS NULL OR "decided_at" IS NULL OR "closed_at" >= "decided_at")
  )
);
CREATE UNIQUE INDEX "class_join_requests_identity_key" ON "class_join_requests" ("id", "session_id", "user_id");
-- An accepted, unused/active admission also blocks a second pending request.
CREATE UNIQUE INDEX "class_join_requests_one_current_key" ON "class_join_requests" ("session_id", "user_id")
  WHERE "status" IN ('PENDING', 'ACCEPTED');
CREATE INDEX "class_join_requests_queue_idx" ON "class_join_requests" ("session_id", "status", "requested_at", "id");
CREATE INDEX "class_join_requests_history_idx" ON "class_join_requests" ("session_id", "user_id", "requested_at", "id");
CREATE INDEX "class_join_requests_user_status_idx" ON "class_join_requests" ("user_id", "status");
CREATE INDEX "class_join_requests_decided_by_id_idx" ON "class_join_requests" ("decided_by_id");

CREATE TABLE "class_participations" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "join_request_id" UUID,
  "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "left_at" TIMESTAMPTZ(3),
  "leave_reason" "class_participation_leave_reason",
  CONSTRAINT "class_participations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_participations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_participations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_participations_request_identity_fkey" FOREIGN KEY ("join_request_id", "session_id", "user_id")
    REFERENCES "class_join_requests" ("id", "session_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "class_participations_leave_check" CHECK (
    ("left_at" IS NULL AND "leave_reason" IS NULL)
    OR ("left_at" IS NOT NULL AND "leave_reason" IS NOT NULL AND "left_at" >= "joined_at")
  ),
  CONSTRAINT "class_participations_seen_check" CHECK ("last_seen_at" >= "joined_at")
);
CREATE UNIQUE INDEX "class_participations_join_request_id_key" ON "class_participations" ("join_request_id");
CREATE UNIQUE INDEX "class_participations_one_open_key" ON "class_participations" ("session_id", "user_id") WHERE "left_at" IS NULL;
CREATE INDEX "class_participations_session_presence_idx" ON "class_participations" ("session_id", "left_at", "joined_at", "id");
CREATE INDEX "class_participations_user_presence_idx" ON "class_participations" ("user_id", "left_at");

COMMIT;
