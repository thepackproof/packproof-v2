-- Support never becomes a Proof participant. Every permission is scoped and expires.
CREATE TABLE support_access_grants (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  support_user_id TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK(scope IN ('METADATA','EVIDENCE_READ')),
  evidence_ids JSONB NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  issue_reference TEXT NOT NULL CHECK(length(issue_reference) BETWEEN 3 AND 200),
  operation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK(support_user_id <> approved_by),
  CHECK(expires_at > created_at AND expires_at <= created_at + INTERVAL '1 hour'),
  CHECK(jsonb_typeof(evidence_ids)='array' AND jsonb_array_length(evidence_ids)<=10),
  CHECK((scope='METADATA' AND jsonb_array_length(evidence_ids)=0) OR (scope='EVIDENCE_READ' AND jsonb_array_length(evidence_ids)>0)),
  UNIQUE(approved_by,operation_id)
);
CREATE TABLE support_access_revocations (
  grant_id TEXT PRIMARY KEY REFERENCES support_access_grants(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE support_access_audit (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES support_access_grants(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('GRANTED','REVOKED','METADATA_READ','EVIDENCE_READ_STARTED')),
  evidence_id TEXT,
  operation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX support_access_grants_reader ON support_access_grants(support_user_id,expires_at);
CREATE INDEX support_access_audit_grant ON support_access_audit(grant_id,created_at);
CREATE TRIGGER support_access_grants_immutable BEFORE UPDATE OR DELETE ON support_access_grants FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TRIGGER support_access_revocations_immutable BEFORE UPDATE OR DELETE ON support_access_revocations FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TRIGGER support_access_audit_immutable BEFORE UPDATE OR DELETE ON support_access_audit FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
INSERT INTO policy_recovery_tables(table_name,key_columns) VALUES ('support_access_grants',ARRAY['id']),('support_access_revocations',ARRAY['grant_id']);
CREATE TRIGGER support_access_grants_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON support_access_grants FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
CREATE TRIGGER support_access_revocations_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON support_access_revocations FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
