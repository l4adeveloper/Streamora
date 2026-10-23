ALTER TABLE "groups"
    ADD CONSTRAINT "groups_owner_id_fkey" FOREIGN KEY ("owner_id")
    REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "group_members"
    ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "groups_deleted_at_created_at_id_idx"
    ON "groups" ("deleted_at", "created_at", "id");

CREATE TABLE "group_create_requests" (
    "user_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    CONSTRAINT "group_create_requests_pkey" PRIMARY KEY ("user_id", "key"),
    CONSTRAINT "group_create_requests_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
