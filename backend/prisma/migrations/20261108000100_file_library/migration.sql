CREATE TYPE file_status AS ENUM ('PENDING', 'AVAILABLE', 'DELETED');
CREATE TYPE file_source AS ENUM ('DOCUMENT', 'LOCAL_RECORDING', 'CLOUD_RECORDING');
CREATE TABLE recording_assets (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES class_sessions(id) ON DELETE RESTRICT
);
CREATE TABLE files (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  name varchar(255) NOT NULL CHECK (length(trim(name)) > 0),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  mime_type varchar(255) NOT NULL,
  source file_source NOT NULL,
  status file_status NOT NULL DEFAULT 'PENDING',
  object_key varchar(1024) NOT NULL UNIQUE,
  session_id uuid REFERENCES class_sessions(id) ON DELETE RESTRICT,
  recording_id uuid UNIQUE REFERENCES recording_assets(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz(3),
  CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
);
CREATE INDEX files_group_id_status_created_at_id_idx ON files(group_id,status,created_at,id);
-- Arbitrary substring ILIKE needs a trigram index, not a plain name btree.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX files_name_trgm_idx ON files USING gin(name gin_trgm_ops) WHERE status <> 'DELETED';
CREATE TABLE file_usages (
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  reference varchar(200) NOT NULL,
  PRIMARY KEY (file_id, reference)
);
CREATE TABLE file_object_deletions (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE RESTRICT,
  object_key varchar(1024) NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz(3)
);
CREATE INDEX file_object_deletions_completed_at_next_attempt_at_idx ON file_object_deletions(completed_at,next_attempt_at);
