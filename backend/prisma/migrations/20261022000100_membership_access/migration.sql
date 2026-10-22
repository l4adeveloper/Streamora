CREATE INDEX "group_members_group_id_joined_at_user_id_idx"
  ON "group_members" ("group_id", "joined_at", "user_id");

CREATE TABLE "membership_changes" (
  "version" BIGSERIAL PRIMARY KEY,
  "group_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "group_member_role",
  "removed" BOOLEAN NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "media_synced_at" TIMESTAMPTZ(3),
  "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "membership_change_payload_check" CHECK (
    ("removed" AND "role" IS NULL) OR
    (NOT "removed" AND "role" IS NOT NULL AND "role" IN ('HOST', 'VIEWER'))
  )
);
CREATE INDEX "membership_changes_media_synced_at_next_attempt_at_version_idx"
  ON "membership_changes" ("media_synced_at", "next_attempt_at", "version");

CREATE TABLE "membership_lookup_windows" (
  "user_id" UUID PRIMARY KEY,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL CHECK ("attempts" > 0)
);

CREATE TABLE "group_rooms" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "group_id" UUID NOT NULL REFERENCES "groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" VARCHAR(100) NOT NULL,
  "room_name" VARCHAR(200) NOT NULL UNIQUE
);
CREATE INDEX "group_rooms_group_id_idx" ON "group_rooms" ("group_id");
