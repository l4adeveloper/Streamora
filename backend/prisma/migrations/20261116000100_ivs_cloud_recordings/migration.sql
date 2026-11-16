ALTER TABLE class_recordings
  ADD COLUMN provider VARCHAR(12) NOT NULL DEFAULT 'BROWSER',
  ADD COLUMN stage_arn TEXT,
  ADD COLUMN composition_arn TEXT,
  ADD COLUMN recording_prefix TEXT,
  ADD COLUMN storage_location_id VARCHAR(64),
  ADD COLUMN next_check_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN worker_lease_until TIMESTAMPTZ(3),
  ADD COLUMN worker_lease_owner UUID,
  ADD COLUMN error_code VARCHAR(64);

CREATE INDEX class_recordings_cloud_pending_idx ON class_recordings(next_check_at)
  WHERE provider = 'IVS' AND status IN ('RECORDING', 'SAVING');
