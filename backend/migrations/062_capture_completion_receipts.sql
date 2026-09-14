-- Additive host polling receipts. Existing launch intents and final manifests are untouched.
CREATE TABLE capture_completion_receipts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES capture_intents(id),
  capture_session_id TEXT NOT NULL UNIQUE REFERENCES capture_engine_sessions(session_id),
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  final_manifest_id TEXT NOT NULL REFERENCES final_manifests(id),
  canonical_json TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  signature_json JSONB NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  CHECK (signature_json->>'algorithm' IN ('ECDSA_SHA_256','RSASSA_PSS_SHA_256')),
  CHECK (length(signature_json->>'keyId') > 0),
  CHECK (length(signature_json->>'signatureBase64') > 0)
);

CREATE FUNCTION protect_capture_completion_receipt() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CAPTURE_COMPLETION_RECEIPT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER capture_completion_receipt_guard
  BEFORE UPDATE OR DELETE ON capture_completion_receipts
  FOR EACH ROW EXECUTE PROCEDURE protect_capture_completion_receipt();
