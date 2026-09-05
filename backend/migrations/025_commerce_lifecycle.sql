-- Receipt and return evidence supplement the frozen seller manifest.
CREATE TABLE IF NOT EXISTS commerce_receivers (
  proof_id TEXT PRIMARY KEY REFERENCES proofs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS commerce_stages (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  stage_type TEXT NOT NULL CHECK (stage_type IN ('RECEIPT','RETURN_PACKING','RETURN_RECEIPT')),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  canonical_json TEXT,
  sha256 TEXT,
  UNIQUE(proof_id,stage_type),
  CHECK ((finalized_at IS NULL AND canonical_json IS NULL AND sha256 IS NULL) OR (finalized_at IS NOT NULL AND canonical_json IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS commerce_stage_evidence (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES commerce_stages(id),
  idempotency_key TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  discarded_at TIMESTAMPTZ,
  byte_size BIGINT,
  sha256 TEXT,
  UNIQUE(stage_id,idempotency_key),
  CHECK ((committed_at IS NULL AND byte_size IS NULL AND sha256 IS NULL) OR (committed_at IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE OR REPLACE FUNCTION commerce_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.finalized_at IS NOT NULL OR NEW.proof_id<>OLD.proof_id OR NEW.stage_type<>OLD.stage_type OR NEW.actor_user_id<>OLD.actor_user_id THEN
    RAISE EXCEPTION 'COMMERCE_STAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commerce_stage_immutable BEFORE UPDATE OR DELETE ON commerce_stages FOR EACH ROW EXECUTE FUNCTION commerce_stage_guard();
CREATE OR REPLACE FUNCTION commerce_stage_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.committed_at IS NOT NULL OR OLD.discarded_at IS NOT NULL)) THEN RAISE EXCEPTION 'COMMERCE_STAGE_IMMUTABLE'; END IF;
  IF EXISTS(SELECT 1 FROM commerce_stages WHERE id=NEW.stage_id AND finalized_at IS NOT NULL) THEN RAISE EXCEPTION 'COMMERCE_STAGE_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commerce_stage_evidence_immutable BEFORE INSERT OR UPDATE OR DELETE ON commerce_stage_evidence FOR EACH ROW EXECUTE FUNCTION commerce_stage_evidence_guard();
