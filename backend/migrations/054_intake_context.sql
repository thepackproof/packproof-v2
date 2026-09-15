-- Additive order-intake contract. Existing Proofs retain their original contract.
SET lock_timeout = '5s';
CREATE TABLE intake_contract_cohorts (
  owner_user_id text PRIMARY KEY REFERENCES users(id),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE intake_source_observations (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES users(id),
  connection_id text NOT NULL,
  receipt_id text NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('API_OBSERVED','BROWSER_CAPTURED','FORWARDED_EMAIL','SELLER_DECLARED')),
  adapter_key text NOT NULL,
  adapter_version text NOT NULL,
  tenant_key text NOT NULL,
  external_order_id text,
  source_revision text,
  source_occurred_at timestamptz,
  received_at timestamptz NOT NULL,
  raw_source_ref text,
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  context jsonb NOT NULL,
  UNIQUE(actor_user_id,connection_id,receipt_id)
);
CREATE INDEX intake_observations_identity ON intake_source_observations(tenant_key,external_order_id,received_at DESC);
CREATE TABLE intake_order_snapshots (
  id text PRIMARY KEY,
  transaction_id text NOT NULL REFERENCES transactions(id),
  proof_id text NOT NULL REFERENCES proofs(id),
  version integer NOT NULL CHECK(version>0),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  material_digest text NOT NULL CHECK(material_digest ~ '^[a-f0-9]{64}$'),
  context jsonb NOT NULL,
  observation_id text NOT NULL REFERENCES intake_source_observations(id),
  created_at timestamptz NOT NULL,
  UNIQUE(proof_id,version), UNIQUE(proof_id,digest)
);
CREATE TABLE proof_order_contexts (
  proof_id text PRIMARY KEY REFERENCES proofs(id),
  contract_version integer NOT NULL CHECK(contract_version IN (0,1)),
  approved_snapshot_id text REFERENCES intake_order_snapshots(id),
  material_conflict boolean NOT NULL DEFAULT false,
  admitted_at timestamptz NOT NULL
);
CREATE TABLE intake_delivery_receipts (
  observation_id text PRIMARY KEY REFERENCES intake_source_observations(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  transaction_id text REFERENCES transactions(id),
  proof_id text REFERENCES proofs(id),
  readiness text NOT NULL CHECK(readiness IN ('RECEIVED','NEEDS_INFORMATION','READY','QUARANTINED','ARCHIVED')),
  result jsonb NOT NULL,
  processed_at timestamptz NOT NULL
);
CREATE INDEX intake_ready_owner ON intake_delivery_receipts(actor_user_id,processed_at DESC);
ALTER TABLE capture_sessions ADD COLUMN order_snapshot_id text REFERENCES intake_order_snapshots(id);
ALTER TABLE capture_sessions ADD COLUMN order_snapshot_version integer;
ALTER TABLE capture_sessions ADD COLUMN order_snapshot_sha256 text;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_snapshot_complete CHECK (
 (order_snapshot_id IS NULL AND order_snapshot_version IS NULL AND order_snapshot_sha256 IS NULL)
 OR (order_snapshot_id IS NOT NULL AND order_snapshot_version > 0 AND order_snapshot_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION protect_intake_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'INTAKE_CONTEXT_IMMUTABLE'; END; $$;
CREATE TRIGGER intake_observations_immutable BEFORE UPDATE OR DELETE ON intake_source_observations FOR EACH ROW EXECUTE FUNCTION protect_intake_immutable();
CREATE TRIGGER intake_snapshots_immutable BEFORE UPDATE OR DELETE ON intake_order_snapshots FOR EACH ROW EXECUTE FUNCTION protect_intake_immutable();
CREATE TRIGGER intake_receipts_immutable BEFORE UPDATE OR DELETE ON intake_delivery_receipts FOR EACH ROW EXECUTE FUNCTION protect_intake_immutable();
CREATE FUNCTION protect_proof_order_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ORDER_CONTRACT_IMMUTABLE'; END IF;
 IF OLD.proof_id IS DISTINCT FROM NEW.proof_id OR OLD.contract_version IS DISTINCT FROM NEW.contract_version OR OLD.admitted_at IS DISTINCT FROM NEW.admitted_at THEN RAISE EXCEPTION 'ORDER_CONTRACT_IMMUTABLE'; END IF;
 IF OLD.approved_snapshot_id IS NOT NULL AND OLD.approved_snapshot_id IS DISTINCT FROM NEW.approved_snapshot_id AND EXISTS(SELECT 1 FROM capture_sessions WHERE proof_id=OLD.proof_id AND order_snapshot_id IS NOT NULL) THEN RAISE EXCEPTION 'ORDER_SNAPSHOT_ALREADY_PINNED'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER proof_order_contract_immutable BEFORE UPDATE OR DELETE ON proof_order_contexts FOR EACH ROW EXECUTE FUNCTION protect_proof_order_contract();
CREATE FUNCTION protect_capture_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot intake_order_snapshots;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.order_snapshot_id IS NOT NULL THEN RAISE EXCEPTION 'CAPTURE_ORDER_CONTEXT_IMMUTABLE'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.order_snapshot_id IS NOT NULL AND (OLD.order_snapshot_id IS DISTINCT FROM NEW.order_snapshot_id OR OLD.order_snapshot_version IS DISTINCT FROM NEW.order_snapshot_version OR OLD.order_snapshot_sha256 IS DISTINCT FROM NEW.order_snapshot_sha256) THEN RAISE EXCEPTION 'CAPTURE_ORDER_CONTEXT_IMMUTABLE'; END IF;
 IF NEW.order_snapshot_id IS NOT NULL THEN
  SELECT * INTO snapshot FROM intake_order_snapshots WHERE id=NEW.order_snapshot_id;
  IF snapshot.proof_id IS DISTINCT FROM NEW.proof_id OR snapshot.version IS DISTINCT FROM NEW.order_snapshot_version OR snapshot.digest IS DISTINCT FROM NEW.order_snapshot_sha256 THEN RAISE EXCEPTION 'CAPTURE_ORDER_CONTEXT_MISMATCH'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER capture_order_snapshot_immutable BEFORE UPDATE OR DELETE ON capture_sessions FOR EACH ROW EXECUTE FUNCTION protect_capture_order_snapshot();
RESET lock_timeout;
