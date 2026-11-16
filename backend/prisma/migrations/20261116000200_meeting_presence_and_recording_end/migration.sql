ALTER TABLE class_media_connections ADD COLUMN presence_verified_at TIMESTAMPTZ(3);
ALTER TABLE class_sessions ADD COLUMN end_requested_at TIMESTAMPTZ(3);
CREATE INDEX class_sessions_pending_end_idx ON class_sessions(id)
  WHERE status = 'LIVE' AND end_requested_at IS NOT NULL;
