-- Policy rollout: existing rows retain explicit legacy origin. Frozen manifests are untouched.
CREATE TABLE capture_sessions (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  stage_id TEXT REFERENCES commerce_stages(id),
  idempotency_key TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('WEB_CAMERA','NATIVE_CAMERA')),
  policy_version TEXT NOT NULL,
  workflow_step TEXT NOT NULL DEFAULT 'PACKING',
  state TEXT NOT NULL CHECK (state IN ('ISSUED','RECORDED','UPLOADING','COMMITTED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  recover_until TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ,
  expected_sha256 TEXT,
  expected_byte_size BIGINT,
  content_type TEXT,
  evidence_id TEXT UNIQUE,
  verified_duration_ms BIGINT,
  UNIQUE(proof_id,actor_user_id,idempotency_key)
);
ALTER TABLE evidence ADD COLUMN captured_duration_ms BIGINT;
ALTER TABLE evidence ADD COLUMN capture_session_id TEXT REFERENCES capture_sessions(id);
ALTER TABLE evidence ADD COLUMN capture_origin TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN';
ALTER TABLE evidence ALTER COLUMN capture_origin SET DEFAULT 'UPLOADED_ATTACHMENT';
ALTER TABLE commerce_stage_evidence ADD COLUMN capture_session_id TEXT REFERENCES capture_sessions(id);
ALTER TABLE commerce_stage_evidence ADD COLUMN capture_origin TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN';
ALTER TABLE commerce_stage_evidence ALTER COLUMN capture_origin SET DEFAULT 'UPLOADED_ATTACHMENT';
ALTER TABLE commerce_stage_evidence ADD COLUMN captured_duration_ms BIGINT;
CREATE UNIQUE INDEX stage_evidence_capture_session_unique ON commerce_stage_evidence(capture_session_id) WHERE capture_session_id IS NOT NULL;
CREATE UNIQUE INDEX evidence_capture_session_unique ON evidence(capture_session_id) WHERE capture_session_id IS NOT NULL;
CREATE INDEX capture_sessions_actor ON capture_sessions(actor_user_id,created_at DESC);
CREATE TABLE packing_relay_stations (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  controller_token_hash TEXT NOT NULL,
  camera_token_hash TEXT,
  pairing_token_hash TEXT NOT NULL,
  pairing_expires_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  camera_paired_at TIMESTAMPTZ,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  active_proof_id TEXT REFERENCES proofs(id),
  active_capture_session_id TEXT REFERENCES capture_sessions(id),
  state TEXT NOT NULL DEFAULT 'PAIRING' CHECK (state IN ('PAIRING','READY','SELECTED','RECORDING','SAVING','SAVED','CANCELLED'))
);
CREATE TABLE packing_relay_commands (
  station_id TEXT NOT NULL REFERENCES packing_relay_stations(id),
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  command_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  capture_session_id TEXT UNIQUE REFERENCES capture_sessions(id),
  PRIMARY KEY(station_id,sequence),
  UNIQUE(station_id,idempotency_key)
);

CREATE OR REPLACE FUNCTION protect_capture_session_binding() RETURNS trigger AS $$
BEGIN
  IF NEW.proof_id IS DISTINCT FROM OLD.proof_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
     OR NEW.client IS DISTINCT FROM OLD.client OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.workflow_step IS DISTINCT FROM OLD.workflow_step OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.recover_until IS DISTINCT FROM OLD.recover_until
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR (OLD.expected_sha256 IS NOT NULL AND (NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
         OR NEW.expected_byte_size IS DISTINCT FROM OLD.expected_byte_size OR NEW.content_type IS DISTINCT FROM OLD.content_type))
     OR (OLD.recorded_at IS NOT NULL AND NEW.recorded_at IS DISTINCT FROM OLD.recorded_at)
     OR (OLD.evidence_id IS NOT NULL AND NEW.evidence_id IS DISTINCT FROM OLD.evidence_id)
     OR (OLD.state='CANCELLED' AND NEW.state IS DISTINCT FROM OLD.state)
     OR (OLD.state='COMMITTED' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'CAPTURE_SESSION_IMMUTABLE' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER capture_session_binding_guard BEFORE UPDATE ON capture_sessions FOR EACH ROW EXECUTE PROCEDURE protect_capture_session_binding();
