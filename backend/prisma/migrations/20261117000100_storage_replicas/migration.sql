CREATE TABLE storage_replicas (
 id UUID PRIMARY KEY,
 kind VARCHAR(12) NOT NULL CHECK (kind IN ('RAW','LIVE_DVR')),
 asset_id UUID NOT NULL,
 destination_bucket VARCHAR(255) NOT NULL,
 source JSONB NOT NULL,
 snapshot JSONB,
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COPYING','READY','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_run_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_owner UUID,
 lease_until TIMESTAMPTZ(3),
 error_code VARCHAR(64),
 object_count INTEGER NOT NULL DEFAULT 0,
 last_synced_at TIMESTAMPTZ(3),
 ready_through_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (ready_through_seconds >= 0),
 completed BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(kind, asset_id, destination_bucket)
);
CREATE INDEX storage_replicas_work_idx ON storage_replicas(next_run_at, lease_until);
