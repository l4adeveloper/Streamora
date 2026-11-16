CREATE TABLE video_replicas (
  id UUID PRIMARY KEY,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL,
  destination_bucket VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COPYING','READY','FAILED')),
  output JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner UUID,
  lease_until TIMESTAMPTZ(3),
  error_code VARCHAR(64),
  object_count INTEGER NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id, file_id) REFERENCES video_jobs(id, file_id) ON DELETE RESTRICT,
  UNIQUE (job_id, destination_bucket)
);
CREATE INDEX video_replicas_work_idx ON video_replicas(status, next_run_at, lease_until);
