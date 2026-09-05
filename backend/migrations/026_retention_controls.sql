CREATE TABLE IF NOT EXISTS proof_retention_holds (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS proof_retention_hold_active ON proof_retention_holds(proof_id) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS proof_deletion_requests (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','CANCELLED','COMPLETED')),
  UNIQUE(proof_id,requested_by)
);
CREATE OR REPLACE FUNCTION commerce_receiver_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.user_id<>OLD.user_id OR NEW.proof_id<>OLD.proof_id OR NEW.invited_by<>OLD.invited_by OR OLD.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'COMMERCE_STAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commerce_receiver_identity BEFORE UPDATE OR DELETE ON commerce_receivers FOR EACH ROW EXECUTE FUNCTION commerce_receiver_guard();
