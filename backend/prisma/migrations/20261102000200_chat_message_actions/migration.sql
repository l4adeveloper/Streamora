BEGIN;

ALTER TABLE "group_chat_messages"
  ADD COLUMN "reply_to_id" UUID,
  ADD COLUMN "edited_at" TIMESTAMPTZ(3),
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

ALTER TABLE "group_chat_messages"
  ADD CONSTRAINT "group_chat_messages_reply_to_id_fkey"
  FOREIGN KEY ("reply_to_id") REFERENCES "group_chat_messages" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "group_chat_messages_reply_to_id_idx"
  ON "group_chat_messages" ("reply_to_id");

COMMIT;
