-- Transaction-level integration identity for import idempotency.
-- This is not a second Proof identity mechanism. Proof bindings remain
-- in proof_external_references and are established when a Proof exists.

CREATE TABLE transaction_integration_identities (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions (id),
  tenant_key TEXT NOT NULL,
  external_transaction_id TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT transaction_integration_identities_tenant_ext_key
    UNIQUE (tenant_key, external_transaction_id),
  CONSTRAINT transaction_integration_identities_txn_tenant_key
    UNIQUE (transaction_id, tenant_key),
  CONSTRAINT transaction_integration_identities_source_check CHECK (
    source IN (
      'MARKETPLACE_API',
      'STOREFRONT_API',
      'SHIPPING_PROVIDER_API',
      'LABEL_SCAN',
      'PARTICIPANT_SUPPLIED'
    )
  )
);

CREATE INDEX transaction_integration_identities_txn_idx
  ON transaction_integration_identities (transaction_id);

CREATE FUNCTION reject_integration_identity_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'INTEGRATION_IDENTITY_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transaction_integration_identities_immutable_update
  BEFORE UPDATE ON transaction_integration_identities
  FOR EACH ROW
  EXECUTE PROCEDURE reject_integration_identity_mutation();

CREATE TRIGGER transaction_integration_identities_immutable_delete
  BEFORE DELETE ON transaction_integration_identities
  FOR EACH ROW
  EXECUTE PROCEDURE reject_integration_identity_mutation();
