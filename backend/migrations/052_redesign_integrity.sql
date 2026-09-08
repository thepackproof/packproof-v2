-- Preserve new source observations and decisions independently of the frozen Proof core.
CREATE TABLE transaction_source_observations (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  adapter_key TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  UNIQUE(transaction_id, adapter_key, payload_sha256)
);
CREATE TRIGGER transaction_source_observations_immutable BEFORE UPDATE OR DELETE ON transaction_source_observations FOR EACH ROW EXECUTE PROCEDURE protect_capture_shipping();
ALTER TABLE capture_label_observations ADD COLUMN raw_value TEXT;
ALTER TABLE capture_label_observations ADD COLUMN observation_context JSONB;
CREATE TABLE capture_label_resolutions (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE REFERENCES capture_label_observations(id),
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK(decision='NOT_THIS_PACKAGE'),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER capture_label_resolutions_immutable BEFORE UPDATE OR DELETE ON capture_label_resolutions FOR EACH ROW EXECUTE PROCEDURE protect_capture_shipping();
CREATE TABLE account_deletion_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(state IN ('REQUESTED','IN_REVIEW','COMPLETED','DECLINED')),
  requested_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
