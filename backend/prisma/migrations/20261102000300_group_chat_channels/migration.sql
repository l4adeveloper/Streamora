BEGIN;

CREATE TABLE "group_chat_channels" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "group_id" UUID NOT NULL REFERENCES "groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" VARCHAR(40) NOT NULL,
  "created_by_id" UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_chat_channels_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 40)
);

CREATE UNIQUE INDEX "group_chat_channels_group_id_name_key"
  ON "group_chat_channels" ("group_id", "name");
CREATE INDEX "group_chat_channels_group_id_created_at_id_idx"
  ON "group_chat_channels" ("group_id", "created_at", "id");
CREATE INDEX "group_chat_channels_created_by_id_idx"
  ON "group_chat_channels" ("created_by_id");

COMMIT;
