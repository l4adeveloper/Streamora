ALTER TABLE "auth_sessions"
  ADD COLUMN "refresh_recovery_token" TEXT,
  ADD COLUMN "refresh_recovery_until" TIMESTAMPTZ(3);
