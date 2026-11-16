ALTER TABLE folders ADD COLUMN session_id UUID UNIQUE REFERENCES class_sessions(id) ON DELETE RESTRICT;
CREATE TABLE lesson_summaries (
 id UUID PRIMARY KEY,
 folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
 requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','READY','FAILED')),
 custom_prompt VARCHAR(4000) NOT NULL,
 input_hash CHAR(64) NOT NULL,
 inputs JSONB NOT NULL,
 deployment VARCHAR(128) NOT NULL,
 result_file_id UUID UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
 content TEXT,
 error_code VARCHAR(64),
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_until TIMESTAMPTZ(3),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 completed_at TIMESTAMPTZ(3),
 UNIQUE(folder_id,input_hash)
);
CREATE INDEX lesson_summaries_queue_idx ON lesson_summaries(status,lease_until,created_at);
CREATE UNIQUE INDEX lesson_summaries_active_idx ON lesson_summaries(folder_id) WHERE status IN ('PENDING','PROCESSING');
