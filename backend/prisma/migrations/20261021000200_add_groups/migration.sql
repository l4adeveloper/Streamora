-- T02: groups and group_members tables
-- Migration: 20261021000200_add_groups

-- Enum for group member roles
CREATE TYPE "group_member_role" AS ENUM ('OWNER', 'HOST', 'VIEWER');

-- Groups table with soft-delete support
CREATE TABLE "groups" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "name"        VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "owner_id"    UUID         NOT NULL,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"  TIMESTAMPTZ(3),

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- Group members table (composite PK = userId + groupId)
CREATE TABLE "group_members" (
    "user_id"   UUID               NOT NULL,
    "group_id"  UUID               NOT NULL,
    "role"      "group_member_role" NOT NULL DEFAULT 'VIEWER',
    "joined_at" TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("user_id", "group_id")
);

-- Indexes for groups
CREATE INDEX "groups_owner_id_idx"  ON "groups" ("owner_id");
CREATE INDEX "groups_deleted_at_idx" ON "groups" ("deleted_at");

-- Indexes for group_members
CREATE INDEX "group_members_group_id_role_idx" ON "group_members" ("group_id", "role");

-- FK from group_members to groups (CASCADE delete cleans members when group is hard-deleted)
ALTER TABLE "group_members"
    ADD CONSTRAINT "group_members_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "groups" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
