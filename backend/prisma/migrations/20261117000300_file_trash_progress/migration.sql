ALTER TABLE file_object_deletions
  ADD COLUMN trash_progress_percent INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT file_object_deletions_trash_progress_percent_check
    CHECK (trash_progress_percent BETWEEN 0 AND 100);
