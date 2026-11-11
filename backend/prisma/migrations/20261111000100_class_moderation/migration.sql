BEGIN;

ALTER TABLE session_bans ADD COLUMN reason VARCHAR(500);
CREATE INDEX session_bans_session_id_revoked_at_banned_at_user_id_idx
  ON session_bans (session_id, revoked_at, banned_at, user_id);

CREATE TABLE session_mic_locks (
  session_id UUID NOT NULL REFERENCES class_sessions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY (session_id, user_id)
);

ALTER TABLE class_media_connections ADD COLUMN can_publish BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE class_session_changes DROP CONSTRAINT class_session_changes_kind_check;
ALTER TABLE class_session_changes ADD CONSTRAINT class_session_changes_kind_check
  CHECK (kind IN ('session.changed', 'session.ended', 'queue.changed', 'admission.changed',
    'participants.changed', 'access.changed', 'meeting.created', 'moderation.mute', 'moderation.changed',
    'moderation.banned'));

COMMIT;
