CREATE TABLE class_media_rooms (
  session_id UUID PRIMARY KEY REFERENCES class_sessions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  stage_arn VARCHAR(200) UNIQUE,
  stage_session_id VARCHAR(100),
  state VARCHAR(20) NOT NULL DEFAULT 'PROVISIONING' CHECK (state IN ('PROVISIONING','READY','CLOSING','CLOSED')),
  lease_until TIMESTAMPTZ(3),
  checked_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE TABLE class_media_connections (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES class_media_rooms(session_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  participation_id UUID NOT NULL REFERENCES class_participations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  auth_session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  client_id UUID NOT NULL,
  request_id UUID NOT NULL,
  participant_id VARCHAR(64) UNIQUE,
  token_ciphertext TEXT,
  expires_at TIMESTAMPTZ(3),
  lease_until TIMESTAMPTZ(3),
  state VARCHAR(20) NOT NULL DEFAULT 'ISSUING' CHECK (state IN ('ISSUING','ACTIVE','REVOKING','REVOKED')),
  connected BOOLEAN NOT NULL DEFAULT false,
  mic_enabled BOOLEAN,
  camera_enabled BOOLEAN,
  last_seen_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (participation_id, client_id)
);
CREATE INDEX class_media_connections_state_checked_at_idx ON class_media_connections(state, checked_at);
CREATE TABLE class_media_requests (
  id UUID PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES class_media_connections(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE TABLE session_bans (
  session_id UUID NOT NULL REFERENCES class_sessions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  banned_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ(3),
  PRIMARY KEY (session_id, user_id)
);
CREATE TABLE ivs_events (
  id VARCHAR(100) PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES class_media_rooms(session_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  detail_type VARCHAR(100) NOT NULL,
  occurred_at TIMESTAMPTZ(3) NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ(3)
);
CREATE INDEX ivs_events_handled_at_received_at_idx ON ivs_events(handled_at, received_at);
