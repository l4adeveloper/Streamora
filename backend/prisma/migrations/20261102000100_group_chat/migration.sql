BEGIN;

CREATE TABLE "group_chat_messages" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "group_id" UUID NOT NULL REFERENCES "groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sender_id" UUID NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sender_name" VARCHAR(100) NOT NULL,
  "sender_role" VARCHAR(16) NOT NULL,
  "channel" VARCHAR(100) NOT NULL,
  "text" VARCHAR(4000) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_chat_messages_channel_check" CHECK (length(btrim("channel")) BETWEEN 1 AND 100),
  CONSTRAINT "group_chat_messages_text_check" CHECK (length(btrim("text")) BETWEEN 1 AND 4000),
  CONSTRAINT "group_chat_messages_sender_role_check" CHECK ("sender_role" IN ('OWNER', 'HOST', 'VIEWER', 'ADMIN'))
);

CREATE INDEX "group_chat_messages_group_id_channel_created_at_id_idx"
  ON "group_chat_messages" ("group_id", "channel", "created_at", "id");
CREATE INDEX "group_chat_messages_sender_id_created_at_idx"
  ON "group_chat_messages" ("sender_id", "created_at");

COMMIT;
