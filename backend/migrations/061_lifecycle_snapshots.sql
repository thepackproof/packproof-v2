-- A signed index over existing sealed records. This does not replace or rewrite
-- final_manifests, proof_supplements, or commerce_stages.
CREATE TABLE lifecycle_snapshots (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_json TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  signature_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(proof_id, actor_user_id, operation_id)
);
CREATE INDEX lifecycle_snapshots_proof ON lifecycle_snapshots(proof_id, created_at, id);
CREATE FUNCTION reject_lifecycle_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LIFECYCLE_SNAPSHOT_IMMUTABLE';
END;
$$;
CREATE TRIGGER lifecycle_snapshots_no_change BEFORE UPDATE OR DELETE ON lifecycle_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_snapshot_mutation();
