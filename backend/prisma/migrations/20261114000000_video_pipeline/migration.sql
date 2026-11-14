BEGIN;
CREATE TABLE video_assets (
 file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE RESTRICT,
 source jsonb NOT NULL, source_metadata jsonb,
 current_job_id uuid, published_job_id uuid
);
CREATE TABLE video_jobs (
 id uuid PRIMARY KEY, file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
 mode varchar(16) NOT NULL CHECK (mode IN ('TRANSCODE','IMPORT_HLS')),
 encoder varchar(16) NOT NULL CHECK (encoder IN ('ffmpeg','mediaconvert','ivs')),
 state varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','SUBMITTING','PROCESSING','VERIFYING','READY','FAILED')),
 policy jsonb, provider_job_id varchar(100) UNIQUE,
 attempt_no integer NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
 lease_owner uuid, lease_until timestamptz(3), next_run_at timestamptz(3) NOT NULL DEFAULT now(),
 last_dispatch_at timestamptz(3), delivery_count integer NOT NULL DEFAULT 0, error_count integer NOT NULL DEFAULT 0,
 progress_percent integer CHECK (progress_percent BETWEEN 0 AND 100), error_code varchar(64), output jsonb,
 retry_key_hash char(64), retry_actor uuid, submitted_at timestamptz(3),
 created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE (id,file_id), UNIQUE (file_id,retry_actor,retry_key_hash),
 CHECK (state <> 'READY' OR output IS NOT NULL)
);
CREATE UNIQUE INDEX video_jobs_one_active ON video_jobs(file_id) WHERE state IN ('QUEUED','SUBMITTING','PROCESSING','VERIFYING');
CREATE INDEX video_jobs_poll ON video_jobs(state,next_run_at,lease_until);
ALTER TABLE video_assets ADD FOREIGN KEY (current_job_id,file_id) REFERENCES video_jobs(id,file_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE video_assets ADD FOREIGN KEY (published_job_id,file_id) REFERENCES video_jobs(id,file_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION guard_video_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IN ('READY','FAILED') AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'video terminal job is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_terminal BEFORE UPDATE ON video_jobs FOR EACH ROW EXECUTE FUNCTION guard_video_terminal();
CREATE FUNCTION guard_video_publish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.published_job_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM video_jobs WHERE id=NEW.published_job_id AND file_id=NEW.file_id AND state='READY'
 ) THEN RAISE EXCEPTION 'video publication requires READY'; END IF;
 IF TG_OP='UPDATE' AND NEW.source IS DISTINCT FROM OLD.source THEN RAISE EXCEPTION 'video source is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_publish BEFORE INSERT OR UPDATE ON video_assets FOR EACH ROW EXECUTE FUNCTION guard_video_publish();
COMMIT;
