-- Claims access is a revocable authorization around the canonical Proof.
CREATE TABLE claims_authorizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES api_tenants(id),
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  external_id TEXT NOT NULL,
  access_link_id TEXT NOT NULL REFERENCES proof_access_links(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX claims_authorizations_active ON claims_authorizations(tenant_id,proof_id) WHERE revoked_at IS NULL;
CREATE INDEX claims_authorizations_reference ON claims_authorizations(tenant_id,external_id);
CREATE TRIGGER claims_authorization_guard BEFORE UPDATE OR DELETE ON claims_authorizations FOR EACH ROW EXECUTE FUNCTION immutable_access_credential_identity();
CREATE TABLE claims_viewer_sessions (
  access_link_id TEXT PRIMARY KEY REFERENCES proof_access_links(id),
  authorization_id TEXT NOT NULL REFERENCES claims_authorizations(id),
  key_id TEXT NOT NULL REFERENCES api_keys(id),
  ticket_id TEXT NOT NULL,
  worker_reference TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER claims_viewer_immutable BEFORE UPDATE OR DELETE ON claims_viewer_sessions FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TABLE claims_access_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES api_tenants(id),
  key_id TEXT NOT NULL REFERENCES api_keys(id),
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  worker_reference TEXT NOT NULL,
  identifier_types JSONB NOT NULL,
  result_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX claims_access_events_tenant ON claims_access_events(tenant_id,created_at);
CREATE TRIGGER claims_access_immutable BEFORE UPDATE OR DELETE ON claims_access_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
INSERT INTO policy_recovery_tables(table_name,key_columns) VALUES
 ('claims_authorizations',ARRAY['id']),('claims_viewer_sessions',ARRAY['access_link_id']);
CREATE TRIGGER claims_authorizations_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON claims_authorizations FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
CREATE TRIGGER claims_viewer_sessions_policy_recovery AFTER INSERT OR UPDATE OR DELETE ON claims_viewer_sessions FOR EACH ROW EXECUTE FUNCTION capture_policy_recovery_change();
