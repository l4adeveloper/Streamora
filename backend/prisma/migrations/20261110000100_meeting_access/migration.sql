BEGIN;
ALTER TABLE groups ADD COLUMN meeting_sequence INTEGER NOT NULL DEFAULT 0 CHECK (meeting_sequence >= 0);
UPDATE groups g SET meeting_sequence = (SELECT count(*) FROM class_sessions s WHERE s.group_id = g.id);
ALTER TABLE class_sessions ADD COLUMN allow_guests BOOLEAN NOT NULL DEFAULT false;
-- Preserve approval for existing scheduled classes; new meetings use direct member entry.
ALTER TABLE class_sessions ADD COLUMN member_admission VARCHAR(10) NOT NULL DEFAULT 'APPROVAL' CHECK (member_admission IN ('DIRECT', 'APPROVAL'));
ALTER TABLE class_sessions ALTER COLUMN member_admission SET DEFAULT 'DIRECT';
ALTER TABLE group_chat_messages ADD COLUMN meeting_id UUID UNIQUE REFERENCES class_sessions(id) ON DELETE RESTRICT;
ALTER TABLE class_session_changes DROP CONSTRAINT class_session_changes_kind_check;
ALTER TABLE class_session_changes ADD CONSTRAINT class_session_changes_kind_check CHECK (kind IN ('session.changed', 'session.ended', 'queue.changed', 'admission.changed', 'participants.changed', 'access.changed', 'meeting.created'));
CREATE INDEX class_session_changes_meeting_idx ON class_session_changes(version) WHERE kind = 'meeting.created';
COMMIT;
