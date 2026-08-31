-- Automatic fulfillment ingestion: multi-item transactions, participation
-- policy, and mutable commerce-order / connection sync projections.
-- These workflow tables are not part of the immutable core Proof.

ALTER TABLE proofs
  ADD COLUMN participation_policy TEXT NOT NULL DEFAULT 'COUNTERPARTY_REQUIRED';

ALTER TABLE proofs
  ADD CONSTRAINT proofs_participation_policy_check CHECK (
    participation_policy IN ('COUNTERPARTY_REQUIRED', 'COUNTERPARTY_OPTIONAL')
  );

CREATE FUNCTION reject_participation_policy_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW.participation_policy IS DISTINCT FROM OLD.participation_policy THEN
    RAISE EXCEPTION 'PARTICIPATION_POLICY_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proofs_participation_policy_immutable
  BEFORE UPDATE ON proofs
  FOR EACH ROW
  EXECUTE PROCEDURE reject_participation_policy_mutation();

CREATE TABLE transaction_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions (id),
  external_item_id TEXT,
  position INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  sku TEXT,
  quantity INTEGER,
  unit_value NUMERIC(19, 4),
  currency TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT transaction_items_position_positive CHECK (position > 0),
  CONSTRAINT transaction_items_quantity_positive CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT transaction_items_value_nonnegative CHECK (unit_value IS NULL OR unit_value >= 0),
  CONSTRAINT transaction_items_currency_format CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT transaction_items_txn_position_key UNIQUE (transaction_id, position)
);

CREATE UNIQUE INDEX transaction_items_txn_external_uq
  ON transaction_items (transaction_id, external_item_id)
  WHERE external_item_id IS NOT NULL;

CREATE INDEX transaction_items_txn_idx
  ON transaction_items (transaction_id, position);

CREATE TRIGGER transaction_items_reject_finalized_insert
  BEFORE INSERT ON transaction_items
  FOR EACH ROW
  EXECUTE PROCEDURE reject_finalized_shipping_mutation();

CREATE TRIGGER transaction_items_reject_finalized_update
  BEFORE UPDATE ON transaction_items
  FOR EACH ROW
  EXECUTE PROCEDURE reject_finalized_shipping_mutation();

CREATE TRIGGER transaction_items_reject_finalized_delete
  BEFORE DELETE ON transaction_items
  FOR EACH ROW
  EXECUTE PROCEDURE reject_finalized_shipping_mutation();

CREATE UNIQUE INDEX integration_connections_owner_adapter_account_uq
  ON integration_connections (owner_user_id, adapter_key, external_account_reference)
  WHERE external_account_reference IS NOT NULL;

CREATE TABLE commerce_order_records (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connections (id),
  transaction_id TEXT REFERENCES transactions (id),
  commerce_tenant_key TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  external_reference TEXT,
  ordered_at TIMESTAMPTZ,
  payment_state TEXT NOT NULL,
  fulfillment_state TEXT NOT NULL,
  requires_physical_fulfillment BOOLEAN NOT NULL,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  eligibility TEXT NOT NULL,
  provider_updated_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  normalized_fingerprint TEXT NOT NULL,
  CONSTRAINT commerce_order_records_payment_check CHECK (
    payment_state IN ('CONFIRMED', 'PENDING', 'FAILED', 'REFUNDED', 'UNKNOWN')
  ),
  CONSTRAINT commerce_order_records_fulfillment_check CHECK (
    fulfillment_state IN (
      'AWAITING_FULFILLMENT',
      'IN_PROGRESS',
      'FULFILLED',
      'CANCELLED',
      'UNKNOWN'
    )
  ),
  CONSTRAINT commerce_order_records_eligibility_check CHECK (
    eligibility IN ('FULFILLMENT_ELIGIBLE', 'INELIGIBLE')
  ),
  CONSTRAINT commerce_order_records_tenant_order_key UNIQUE (commerce_tenant_key, external_order_id)
);

CREATE INDEX commerce_order_records_connection_idx
  ON commerce_order_records (connection_id, last_seen_at);

CREATE INDEX commerce_order_records_transaction_idx
  ON commerce_order_records (transaction_id);

CREATE FUNCTION reject_commerce_order_transaction_rebind()
RETURNS trigger AS $$
BEGIN
  IF OLD.transaction_id IS NOT NULL
     AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    RAISE EXCEPTION 'COMMERCE_ORDER_REBIND'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commerce_order_records_reject_rebind
  BEFORE UPDATE ON commerce_order_records
  FOR EACH ROW
  EXECUTE PROCEDURE reject_commerce_order_transaction_rebind();

CREATE TABLE commerce_connection_sync_states (
  connection_id TEXT PRIMARY KEY REFERENCES integration_connections (id),
  last_attempted_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_retryable BOOLEAN,
  provider_cursor TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
