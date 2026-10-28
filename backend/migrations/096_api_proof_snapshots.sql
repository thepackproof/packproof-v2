-- Disposable reconciliation projections only: no canonical evidence is changed.
CREATE TABLE api_proof_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES api_tenants(id),
  merchant_id TEXT NOT NULL REFERENCES platform_organizations(id),
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
  principal_id TEXT NOT NULL REFERENCES platform_principals(id),
  credential_id TEXT NOT NULL REFERENCES platform_credentials(id),
  delegation_id TEXT REFERENCES platform_delegations(id),
  slot SMALLINT NOT NULL CHECK(slot BETWEEN 1 AND 4),
  boundary_position BIGINT NOT NULL CHECK(boundary_position >= 0),
  event_cursor TEXT NOT NULL,
  page_size INTEGER NOT NULL CHECK(page_size BETWEEN 1 AND 100),
  row_count INTEGER NOT NULL CHECK(row_count BETWEEN 0 AND 10000),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK(expires_at > created_at AND expires_at <= created_at + INTERVAL '1 hour'),
  UNIQUE(credential_id,slot)
);
CREATE INDEX api_proof_snapshots_expiry ON api_proof_snapshots(expires_at);
CREATE INDEX api_snapshot_bindings_lookup ON platform_external_bindings(merchant_id,environment,proof_id);
CREATE TABLE api_proof_snapshot_rows (
  snapshot_id TEXT NOT NULL REFERENCES api_proof_snapshots(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 10000),
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  row_data JSONB NOT NULL CHECK(jsonb_typeof(row_data)='object'),
  PRIMARY KEY(snapshot_id,ordinal),
  UNIQUE(snapshot_id,proof_id)
);
-- Snapshots have fixed contents. DELETE is reserved for disposable projection
-- expiry/explicit release, and never deletes originals, manifests, or audit rows.
CREATE TRIGGER api_proof_snapshots_no_update BEFORE UPDATE ON api_proof_snapshots
FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER api_proof_snapshot_rows_no_update BEFORE UPDATE ON api_proof_snapshot_rows
FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
