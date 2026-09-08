-- Public verification material only. No fingerprint images, templates, or biometric samples.
-- Existing attestations and frozen manifests retain their original hashes and shapes.
ALTER TABLE attestations ADD COLUMN authorization_json JSONB;

CREATE TABLE attestation_challenges (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  capture_session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  public_key_base64 TEXT NOT NULL,
  public_key_sha256 TEXT NOT NULL CHECK (public_key_sha256 ~ '^[a-f0-9]{64}$'),
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attestation_id TEXT UNIQUE REFERENCES attestations(id),
  CHECK ((consumed_at IS NULL) = (attestation_id IS NULL))
);
CREATE INDEX attestation_challenges_capture_idx
  ON attestation_challenges(proof_id, actor_user_id, capture_session_id, created_at DESC);

CREATE FUNCTION protect_attestation_challenge() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ATTESTATION_CHALLENGE_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.proof_id IS DISTINCT FROM OLD.proof_id
    OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
    OR NEW.capture_session_id IS DISTINCT FROM OLD.capture_session_id
    OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
    OR NEW.public_key_base64 IS DISTINCT FROM OLD.public_key_base64
    OR NEW.public_key_sha256 IS DISTINCT FROM OLD.public_key_sha256
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL OR NEW.attestation_id IS NULL
  THEN RAISE EXCEPTION 'ATTESTATION_CHALLENGE_IMMUTABLE' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM attestations a WHERE a.id = NEW.attestation_id
      AND a.proof_id = NEW.proof_id AND a.attested_by = NEW.actor_user_id
      AND a.authorization_json->>'challengeId' = NEW.id
  ) THEN RAISE EXCEPTION 'ATTESTATION_CHALLENGE_BINDING_INVALID' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER attestation_challenge_guard BEFORE UPDATE OR DELETE ON attestation_challenges
  FOR EACH ROW EXECUTE PROCEDURE protect_attestation_challenge();
