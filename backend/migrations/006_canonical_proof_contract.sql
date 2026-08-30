-- Canonical Proof contract: attestations and tenant-scoped external references.
-- These tables extend the single Proof. They do not create a second evidence model.

CREATE TABLE attestations (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  participant_id TEXT NOT NULL REFERENCES proof_participants (id),
  attested_by TEXT NOT NULL REFERENCES users (id),
  statement TEXT NOT NULL,
  related_evidence_id TEXT REFERENCES evidence (id),
  related_event_id TEXT REFERENCES audit_events (id),
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT attestations_statement_check CHECK (
    statement IN ('PACKED_DESCRIBED_ITEM', 'RECEIVED_PACKAGE')
  )
);

CREATE UNIQUE INDEX attestations_idempotency_null_evidence_uq
  ON attestations (proof_id, attested_by, statement)
  WHERE related_evidence_id IS NULL;

CREATE UNIQUE INDEX attestations_idempotency_evidence_uq
  ON attestations (proof_id, attested_by, statement, related_evidence_id)
  WHERE related_evidence_id IS NOT NULL;

CREATE INDEX attestations_proof_created_idx
  ON attestations (proof_id, created_at);

CREATE TABLE proof_external_references (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  tenant_key TEXT NOT NULL,
  external_transaction_id TEXT NOT NULL,
  source TEXT NOT NULL,
  supplied_by TEXT REFERENCES users (id),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT proof_external_references_tenant_ext_key
    UNIQUE (tenant_key, external_transaction_id),
  CONSTRAINT proof_external_references_source_check CHECK (
    source IN ('PARTICIPANT_SUPPLIED', 'INTEGRATION')
  )
);

CREATE INDEX proof_external_references_proof_id_idx
  ON proof_external_references (proof_id);

CREATE FUNCTION reject_attestation_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ATTESTATION_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attestations_immutable_update
  BEFORE UPDATE ON attestations
  FOR EACH ROW
  EXECUTE PROCEDURE reject_attestation_mutation();

CREATE TRIGGER attestations_immutable_delete
  BEFORE DELETE ON attestations
  FOR EACH ROW
  EXECUTE PROCEDURE reject_attestation_mutation();

CREATE FUNCTION reject_finalized_attestation_write()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM proofs
     WHERE id = NEW.proof_id
       AND status = 'FINALIZED'
  ) THEN
    RAISE EXCEPTION 'PROOF_ALREADY_FINALIZED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attestations_reject_finalized_insert
  BEFORE INSERT ON attestations
  FOR EACH ROW
  EXECUTE PROCEDURE reject_finalized_attestation_write();

CREATE FUNCTION reject_external_reference_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EXTERNAL_REFERENCE_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proof_external_references_immutable_update
  BEFORE UPDATE ON proof_external_references
  FOR EACH ROW
  EXECUTE PROCEDURE reject_external_reference_mutation();

CREATE TRIGGER proof_external_references_immutable_delete
  BEFORE DELETE ON proof_external_references
  FOR EACH ROW
  EXECUTE PROCEDURE reject_external_reference_mutation();
