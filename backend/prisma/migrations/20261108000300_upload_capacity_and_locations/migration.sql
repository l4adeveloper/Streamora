CREATE TABLE storage_locations (
  id CHAR(64) PRIMARY KEY,
  driver VARCHAR(10) NOT NULL CHECK (driver IN ('local','s3')),
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE files ADD COLUMN storage_location_id CHAR(64) REFERENCES storage_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE file_object_deletions ADD COLUMN storage_location_id CHAR(64) REFERENCES storage_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE upload_sessions
  ADD COLUMN storage_location_id CHAR(64) REFERENCES storage_locations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN operation_token UUID,
  ADD COLUMN operation_until TIMESTAMPTZ(3);
ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_status_check;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_status_check CHECK (status IN ('INITIALIZING','ACTIVE','COMPLETING','ABORTING','COMPLETED','ABORTED'));
CREATE INDEX upload_sessions_user_id_status_expires_at_idx ON upload_sessions(user_id,status,expires_at);
CREATE INDEX upload_sessions_group_id_status_expires_at_idx ON upload_sessions(group_id,status,expires_at);
