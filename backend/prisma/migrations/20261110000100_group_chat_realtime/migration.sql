CREATE TABLE "group_chat_changes" (
    "version" BIGSERIAL PRIMARY KEY,
    "group_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "group_chat_changes_created_at_idx" ON "group_chat_changes"("created_at");
