CREATE TYPE file_trash_phase AS ENUM ('ARCHIVING', 'ARCHIVED', 'TRASHED', 'RESTORING', 'RESTORED');

ALTER TABLE file_object_deletions
  ADD COLUMN trash_bucket VARCHAR(222),
  ADD COLUMN trash_key VARCHAR(128),
  ADD COLUMN trash_generation VARCHAR(32),
  ADD COLUMN source_etag VARCHAR(128),
  ADD COLUMN trash_phase file_trash_phase,
  ADD COLUMN lease_owner UUID;

CREATE INDEX file_object_deletions_trash_phase_next_attempt_at_idx
  ON file_object_deletions (trash_phase, next_attempt_at);
