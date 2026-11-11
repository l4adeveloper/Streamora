BEGIN;

CREATE TYPE class_poll_status AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE class_polls (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES class_sessions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_by_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  question VARCHAR(300) NOT NULL,
  status class_poll_status NOT NULL DEFAULT 'OPEN',
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMPTZ(3),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE INDEX class_polls_session_id_created_at_id_idx ON class_polls (session_id, created_at, id);

CREATE TABLE class_poll_options (
  poll_id UUID NOT NULL REFERENCES class_polls(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  id UUID NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 5),
  text VARCHAR(150) NOT NULL,
  PRIMARY KEY (poll_id, id)
);
CREATE UNIQUE INDEX class_poll_options_poll_id_position_key ON class_poll_options (poll_id, position);

CREATE TABLE class_poll_votes (
  poll_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  option_id UUID NOT NULL,
  PRIMARY KEY (poll_id, user_id),
  FOREIGN KEY (poll_id, option_id) REFERENCES class_poll_options(poll_id, id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX class_poll_votes_poll_id_option_id_idx ON class_poll_votes (poll_id, option_id);

ALTER TABLE class_session_changes ADD COLUMN payload JSONB;
ALTER TABLE class_session_changes DROP CONSTRAINT class_session_changes_kind_check;
ALTER TABLE class_session_changes ADD CONSTRAINT class_session_changes_kind_check
  CHECK (kind IN ('session.changed', 'session.ended', 'queue.changed', 'admission.changed',
    'participants.changed', 'access.changed', 'meeting.created', 'moderation.mute', 'moderation.changed',
    'moderation.banned', 'poll.updated'));

CREATE FUNCTION class_poll_public(pid UUID) RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT jsonb_build_object(
    'sessionId', p.session_id, 'pollId', p.id, 'question', p.question,
    'status', p.status, 'version', p.version::text,
    'options', COALESCE(tally.options, '[]'::jsonb),
    'totalVotes', COALESCE(tally.total, 0)
  )
  FROM class_polls p
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', o.id, 'text', o.text, 'count', o.votes)
             ORDER BY o.position) AS options, sum(o.votes) AS total
    FROM (
      SELECT option.id, option.text, option.position, count(vote.user_id) AS votes
      FROM class_poll_options option
      LEFT JOIN class_poll_votes vote
        ON vote.poll_id = option.poll_id AND vote.option_id = option.id
      WHERE option.poll_id = p.id
      GROUP BY option.id, option.text, option.position
    ) o
  ) tally
  WHERE p.id = pid;
$$;

CREATE FUNCTION class_poll_changed(pid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  -- Use the journal's commit-order lock shared with class_realtime_change.
  PERFORM pg_advisory_xact_lock(73005);
  INSERT INTO class_session_changes(event_id, session_id, kind, payload)
    SELECT gen_random_uuid(), session_id, 'poll.updated', class_poll_public(id)
    FROM class_polls WHERE id = pid;
END;
$$;

CREATE FUNCTION class_close_session_polls() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE closed_poll UUID;
BEGIN
  FOR closed_poll IN
    UPDATE class_polls SET status = 'CLOSED', closed_at = COALESCE(NEW.ended_at, clock_timestamp()),
      version = version + 1
    WHERE session_id = NEW.id AND status = 'OPEN'
    RETURNING id
  LOOP
    PERFORM class_poll_changed(closed_poll);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER class_sessions_close_polls AFTER UPDATE OF status ON class_sessions
  FOR EACH ROW WHEN (OLD.status = 'LIVE' AND NEW.status <> 'LIVE')
  EXECUTE FUNCTION class_close_session_polls();

COMMIT;
