BEGIN;
ALTER TABLE "class_participations" ADD COLUMN "presence_checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "class_participations_sweep_idx" ON "class_participations" ("left_at", "presence_checked_at", "id");

CREATE TABLE "class_presence_leases" (
  "id" UUID PRIMARY KEY,
  "participation_id" UUID NOT NULL REFERENCES "class_participations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "auth_session_id" UUID NOT NULL REFERENCES "auth_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "instance_id" UUID NOT NULL,
  "socket_id" VARCHAR(128) NOT NULL,
  "connected" BOOLEAN NOT NULL DEFAULT true,
  "last_heartbeat_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "class_presence_leases_time_check" CHECK ("expires_at" > "last_heartbeat_at")
);
CREATE UNIQUE INDEX "class_presence_leases_connection_key" ON "class_presence_leases" ("instance_id", "socket_id", "participation_id");
CREATE INDEX "class_presence_leases_participation_id_expires_at_idx" ON "class_presence_leases" ("participation_id", "expires_at");
CREATE INDEX "class_presence_leases_auth_session_id_idx" ON "class_presence_leases" ("auth_session_id");

CREATE TABLE "class_session_changes" (
  "version" BIGSERIAL PRIMARY KEY,
  "event_id" UUID NOT NULL UNIQUE,
  "session_id" UUID NOT NULL REFERENCES "class_sessions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind" VARCHAR(32) NOT NULL CHECK ("kind" IN ('session.changed', 'session.ended', 'queue.changed', 'admission.changed', 'participants.changed', 'access.changed')),
  "subject_user_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "class_session_changes_session_id_version_idx" ON "class_session_changes" ("session_id", "version");

-- Allocate versions through commit; no dispatcher can skip a later commit with a lower version.
CREATE FUNCTION class_realtime_change(sid UUID, event_kind TEXT, subject UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(73005);
  INSERT INTO class_session_changes(event_id, session_id, kind, subject_user_id)
    VALUES (gen_random_uuid(), sid, event_kind, subject);
END;
$$;

CREATE FUNCTION class_realtime_session_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM class_realtime_change(NEW.id, 'session.changed');
  ELSIF NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM class_realtime_change(NEW.id, CASE WHEN NEW.status = 'ENDED' AND OLD.status <> 'ENDED' THEN 'session.ended' ELSE 'session.changed' END);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER class_sessions_realtime AFTER INSERT OR UPDATE ON class_sessions
  FOR EACH ROW EXECUTE FUNCTION class_realtime_session_trigger();

CREATE FUNCTION class_realtime_request_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM class_realtime_change(NEW.session_id, 'queue.changed');
    PERFORM class_realtime_change(NEW.session_id, 'admission.changed', NEW.user_id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM class_realtime_change(NEW.session_id, 'queue.changed');
    PERFORM class_realtime_change(NEW.session_id, 'admission.changed', NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER class_join_requests_realtime AFTER INSERT OR UPDATE ON class_join_requests
  FOR EACH ROW EXECUTE FUNCTION class_realtime_request_trigger();

CREATE FUNCTION class_realtime_participation_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM class_realtime_change(NEW.session_id, 'participants.changed');
    PERFORM class_realtime_change(NEW.session_id, 'admission.changed', NEW.user_id);
  ELSIF NEW.left_at IS DISTINCT FROM OLD.left_at THEN
    DELETE FROM class_presence_leases WHERE participation_id = NEW.id;
    PERFORM class_realtime_change(NEW.session_id, 'participants.changed');
    PERFORM class_realtime_change(NEW.session_id, 'admission.changed', NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER class_participations_realtime AFTER INSERT OR UPDATE ON class_participations
  FOR EACH ROW EXECUTE FUNCTION class_realtime_participation_trigger();

CREATE FUNCTION class_realtime_membership_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE sid UUID; gid UUID; uid UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN gid := OLD.group_id; uid := OLD.user_id;
  ELSE gid := NEW.group_id; uid := NEW.user_id; END IF;
  FOR sid IN SELECT id FROM class_sessions WHERE group_id = gid ORDER BY id LOOP
    PERFORM class_realtime_change(sid, 'access.changed', uid);
    PERFORM class_realtime_change(sid, 'participants.changed');
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER class_memberships_realtime AFTER INSERT OR UPDATE OR DELETE ON group_members
  FOR EACH ROW EXECUTE FUNCTION class_realtime_membership_trigger();

CREATE FUNCTION class_realtime_group_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE sid UUID;
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    FOR sid IN SELECT id FROM class_sessions WHERE group_id = NEW.id ORDER BY id LOOP
      PERFORM class_realtime_change(sid, 'access.changed');
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER class_groups_realtime AFTER UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION class_realtime_group_trigger();
COMMIT;
