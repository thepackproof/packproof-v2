-- Immutable accepted events are distinct from the rebuildable delivery projection.
CREATE TABLE recovery_events (
  operation_id TEXT PRIMARY KEY,
  sequence BIGSERIAL UNIQUE NOT NULL,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  kind TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  previous_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER recovery_events_no_change BEFORE UPDATE OR DELETE ON recovery_events
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TABLE recovery_delivery (
  operation_id TEXT PRIMARY KEY REFERENCES recovery_events(operation_id),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','DURABLE','DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  error_code TEXT,
  receipt_json JSONB,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX recovery_delivery_work ON recovery_delivery(state,next_attempt_at,lease_until);
CREATE TABLE recovery_writer_fence (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation TEXT NOT NULL,
  writes_enabled BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO recovery_writer_fence(singleton,generation) VALUES(1,'initial');
CREATE TABLE proof_supplements (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  previous_sha256 TEXT NOT NULL,
  core_manifest_sha256 TEXT NOT NULL,
  signature_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(proof_id,sequence),
  UNIQUE(proof_id,operation_id)
);
CREATE TRIGGER proof_supplements_no_change BEFORE UPDATE OR DELETE ON proof_supplements
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TABLE proof_supplement_heads (
  proof_id TEXT PRIMARY KEY REFERENCES proofs(id),
  sequence INTEGER NOT NULL,
  sha256 TEXT NOT NULL
);

-- Freezing a manifest precedes its durable receipt in strict mode. Protect the
-- frozen core during that interval as well as after the FINALIZED projection.
CREATE FUNCTION reject_prepared_manifest_core_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id TEXT;
BEGIN
  owner_id := CASE WHEN TG_OP='DELETE' THEN OLD.proof_id ELSE NEW.proof_id END;
  IF EXISTS(SELECT 1 FROM final_manifests m JOIN proofs p ON p.id=m.proof_id WHERE m.proof_id=owner_id AND p.status <> 'FINALIZED') THEN
    RAISE EXCEPTION 'PROOF_ALREADY_FINALIZED';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER evidence_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON evidence FOR EACH ROW EXECUTE PROCEDURE reject_prepared_manifest_core_write();
CREATE TRIGGER attestation_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON attestations FOR EACH ROW EXECUTE PROCEDURE reject_prepared_manifest_core_write();
CREATE TRIGGER participant_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON proof_participants FOR EACH ROW EXECUTE PROCEDURE reject_prepared_manifest_core_write();
CREATE TRIGGER capture_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON capture_sessions FOR EACH ROW EXECUTE PROCEDURE reject_prepared_manifest_core_write();
CREATE TRIGGER assets_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON proof_assets FOR EACH ROW EXECUTE PROCEDURE reject_prepared_manifest_core_write();
CREATE TRIGGER observations_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON custody_observations FOR EACH ROW EXECUTE PROCEDURE reject_prepared_manifest_core_write();
CREATE TRIGGER transfers_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON custody_transfers FOR EACH ROW EXECUTE PROCEDURE reject_prepared_manifest_core_write();
CREATE TRIGGER continuity_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON continuity_evaluations FOR EACH ROW EXECUTE PROCEDURE reject_prepared_manifest_core_write();

CREATE FUNCTION reject_prepared_transaction_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_key TEXT;
BEGIN
  IF TG_TABLE_NAME='transactions' THEN
    transaction_key := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    transaction_key := CASE WHEN TG_OP='DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END;
  END IF;
  IF EXISTS(SELECT 1 FROM proofs p JOIN final_manifests m ON m.proof_id=p.id WHERE p.transaction_id=transaction_key) THEN
    RAISE EXCEPTION 'PROOF_ALREADY_FINALIZED';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER transaction_prepared_guard BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE PROCEDURE reject_prepared_transaction_write();
CREATE TRIGGER shipping_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON transaction_shipping FOR EACH ROW EXECUTE PROCEDURE reject_prepared_transaction_write();
CREATE TRIGGER items_prepared_guard BEFORE INSERT OR UPDATE OR DELETE ON transaction_items FOR EACH ROW EXECUTE PROCEDURE reject_prepared_transaction_write();
