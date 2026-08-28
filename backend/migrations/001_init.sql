-- PackProof V2 canonical schema
-- PostgreSQL is the source of domain truth.

CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  external_reference TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  transaction_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX transactions_external_reference_uq
  ON transactions (external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE proofs (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions (id),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  manifest_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT proofs_transaction_id_key UNIQUE (transaction_id),
  CONSTRAINT proofs_status_check CHECK (
    status IN (
      'OPEN',
      'AWAITING_PARTICIPANT',
      'READY_FOR_EVIDENCE',
      'EVIDENCE_COMMITTED',
      'FINALIZED'
    )
  )
);

CREATE TABLE proof_participants (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT proof_participants_role_check CHECK (role IN ('SELLER', 'BUYER')),
  CONSTRAINT proof_participants_proof_user_key UNIQUE (proof_id, user_id),
  CONSTRAINT proof_participants_proof_role_key UNIQUE (proof_id, role)
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  inviter_user_id TEXT NOT NULL REFERENCES users (id),
  invitee_identifier TEXT NOT NULL,
  status TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CONSTRAINT invitations_status_check CHECK (
    status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')
  ),
  CONSTRAINT invitations_token_key UNIQUE (token)
);

CREATE UNIQUE INDEX invitations_proof_invitee_uq
  ON invitations (proof_id, invitee_identifier);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  submitted_by TEXT NOT NULL REFERENCES users (id),
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  validation_status TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  idempotency_key TEXT,
  CONSTRAINT evidence_validation_status_check CHECK (
    validation_status IN ('PENDING', 'COMMITTED', 'REJECTED')
  )
);

CREATE UNIQUE INDEX evidence_proof_idempotency_uq
  ON evidence (proof_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  actor_user_id TEXT REFERENCES users (id),
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  event_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX audit_events_proof_created_idx
  ON audit_events (proof_id, created_at);

CREATE TABLE final_manifests (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  canonical_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT final_manifests_proof_id_key UNIQUE (proof_id)
);

CREATE FUNCTION reject_finalized_proof_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PROOF_ALREADY_FINALIZED'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proofs_reject_finalized_update
  BEFORE UPDATE ON proofs
  FOR EACH ROW
  WHEN (OLD.status = 'FINALIZED')
  EXECUTE PROCEDURE reject_finalized_proof_mutation();

CREATE FUNCTION reject_committed_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.proof_id IS DISTINCT FROM OLD.proof_id
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.evidence_type IS DISTINCT FROM OLD.evidence_type
     OR NEW.object_key IS DISTINCT FROM OLD.object_key THEN
    RAISE EXCEPTION 'EVIDENCE_ALREADY_COMMITTED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_reject_committed_mutation
  BEFORE UPDATE ON evidence
  FOR EACH ROW
  WHEN (OLD.committed_at IS NOT NULL)
  EXECUTE PROCEDURE reject_committed_evidence_mutation();

CREATE FUNCTION reject_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW
  EXECUTE PROCEDURE reject_audit_mutation();

CREATE TRIGGER audit_events_immutable_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW
  EXECUTE PROCEDURE reject_audit_mutation();

CREATE FUNCTION reject_manifest_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'MANIFEST_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER final_manifests_immutable_update
  BEFORE UPDATE ON final_manifests
  FOR EACH ROW
  EXECUTE PROCEDURE reject_manifest_mutation();

CREATE TRIGGER final_manifests_immutable_delete
  BEFORE DELETE ON final_manifests
  FOR EACH ROW
  EXECUTE PROCEDURE reject_manifest_mutation();
