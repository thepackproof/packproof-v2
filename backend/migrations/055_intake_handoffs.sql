-- Durable opt-in recording devices and exact-order delivery. Existing relay/capture semantics remain intact.
CREATE TABLE intake_recording_devices (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  pairing_code_sha256 TEXT NOT NULL,
  pairing_expires_at TIMESTAMPTZ NOT NULL,
  pairing_failures INTEGER NOT NULL DEFAULT 0,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  active_capture_session_id TEXT REFERENCES capture_sessions(id),
  CONSTRAINT intake_recording_device_name CHECK (length(name) BETWEEN 1 AND 80),
  CONSTRAINT intake_recording_device_attempts CHECK (pairing_failures BETWEEN 0 AND 5)
);
CREATE INDEX intake_recording_devices_actor ON intake_recording_devices(actor_user_id,created_at);

CREATE TABLE intake_handoffs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  target_device_id TEXT NOT NULL REFERENCES intake_recording_devices(id),
  tenant_key TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  snapshot_id TEXT NOT NULL REFERENCES intake_order_snapshots(id),
  snapshot_version INTEGER NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  order_card JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','CLAIMED','EXPIRED','REVOKED')),
  claimed_at TIMESTAMPTZ,
  claim_key TEXT,
  capture_session_id TEXT REFERENCES capture_sessions(id),
  claim_response JSONB,
  UNIQUE(actor_user_id,idempotency_key),
  UNIQUE(target_device_id,sequence),
  UNIQUE(capture_session_id),
  CHECK ((state = 'CLAIMED') = (capture_session_id IS NOT NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX intake_handoffs_pending ON intake_handoffs(target_device_id,sequence) WHERE state='PENDING';
CREATE INDEX intake_handoffs_proof ON intake_handoffs(proof_id) WHERE state='CLAIMED';

CREATE FUNCTION protect_intake_handoff_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'INTAKE_HANDOFF_IMMUTABLE'; END IF;
  IF ROW(NEW.id,NEW.actor_user_id,NEW.target_device_id,NEW.tenant_key,NEW.transaction_id,NEW.proof_id,NEW.snapshot_id,NEW.snapshot_version,NEW.snapshot_sha256,NEW.order_card,NEW.idempotency_key,NEW.event_id,NEW.sequence,NEW.created_at,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.actor_user_id,OLD.target_device_id,OLD.tenant_key,OLD.transaction_id,OLD.proof_id,OLD.snapshot_id,OLD.snapshot_version,OLD.snapshot_sha256,OLD.order_card,OLD.idempotency_key,OLD.event_id,OLD.sequence,OLD.created_at,OLD.expires_at)
     OR (OLD.state <> 'PENDING' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'INTAKE_HANDOFF_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER intake_handoff_binding_immutable BEFORE UPDATE OR DELETE ON intake_handoffs
  FOR EACH ROW EXECUTE FUNCTION protect_intake_handoff_binding();
