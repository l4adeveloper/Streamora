BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "global_role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "session_revocation_reason" AS ENUM ('LOGOUT', 'REFRESH_REUSED', 'USER_DISABLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "global_role" "global_role" NOT NULL DEFAULT 'USER',
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason" "session_revocation_reason",

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "auth_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_refresh_tokens_token_hash_key" ON "auth_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_refresh_tokens_expires_at_idx" ON "auth_refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_refresh_tokens_session_id_generation_key" ON "auth_refresh_tokens"("session_id", "generation");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_refresh_tokens" ADD CONSTRAINT "auth_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Native PostgreSQL constraints: keep these when authoring later migrations.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_check"
    CHECK (length("email") > 0 AND "email" = lower(btrim("email"))),
  ADD CONSTRAINT "users_full_name_nonempty_check"
    CHECK (length(btrim("full_name")) > 0),
  ADD CONSTRAINT "users_password_hash_check"
    CHECK ("password_hash" LIKE '$argon2id$%');

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_expiry_check"
    CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "auth_sessions_last_used_check"
    CHECK ("last_used_at" IS NULL OR "last_used_at" >= "created_at"),
  ADD CONSTRAINT "auth_sessions_revocation_check"
    CHECK (("revoked_at" IS NULL AND "revocation_reason" IS NULL)
      OR ("revoked_at" IS NOT NULL AND "revocation_reason" IS NOT NULL AND "revoked_at" >= "created_at"));

ALTER TABLE "auth_refresh_tokens"
  ADD CONSTRAINT "auth_refresh_tokens_hash_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "auth_refresh_tokens_generation_check"
    CHECK ("generation" >= 0),
  ADD CONSTRAINT "auth_refresh_tokens_expiry_check"
    CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "auth_refresh_tokens_consumed_check"
    CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at");

-- Only one unconsumed token may exist per family; retain old hashes for reuse checks.
CREATE UNIQUE INDEX "auth_refresh_tokens_one_current_per_session_key"
  ON "auth_refresh_tokens" ("session_id") WHERE "consumed_at" IS NULL;

COMMIT;

