CREATE TABLE proof_retention_assignments (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  operation_id TEXT NOT NULL UNIQUE,
  policy_id TEXT NOT NULL,
  policy_json JSONB NOT NULL,
  anchors_json JSONB NOT NULL,
  contractual_preserve_until TIMESTAMPTZ,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER proof_retention_assignments_no_change BEFORE UPDATE OR DELETE ON proof_retention_assignments
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
ALTER TABLE proof_retention_holds ADD COLUMN scope TEXT NOT NULL DEFAULT 'PROOF_ORIGINALS_AND_RECORD';
ALTER TABLE proof_retention_holds ADD COLUMN review_at TIMESTAMPTZ;
ALTER TABLE proof_retention_holds ADD COLUMN release_protect_until TIMESTAMPTZ;
CREATE TABLE proof_disposition_state (
  proof_id TEXT PRIMARY KEY REFERENCES proofs(id),
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','DISPOSITION_LOCKED','DISPOSED')),
  locked_at TIMESTAMPTZ,
  notice_at TIMESTAMPTZ,
  tombstone_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE retention_operations_gates (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  approved_policy_reference TEXT,
  successful_restore_drill_reference TEXT,
  disposal_enabled BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO retention_operations_gates(singleton) VALUES(1);
