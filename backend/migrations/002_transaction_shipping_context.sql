-- Transaction and shipping context bound to an existing transaction.
-- These columns are commercial facts, not Proof lifecycle state.

ALTER TABLE transactions
  ADD COLUMN transaction_date TEXT,
  ADD COLUMN item_title TEXT,
  ADD COLUMN item_description TEXT,
  ADD COLUMN quantity INTEGER,
  ADD COLUMN transaction_value NUMERIC(19, 4),
  ADD COLUMN currency TEXT;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_quantity_positive
    CHECK (quantity IS NULL OR quantity > 0);

ALTER TABLE transactions
  ADD CONSTRAINT transactions_value_nonnegative
    CHECK (transaction_value IS NULL OR transaction_value >= 0);

ALTER TABLE transactions
  ADD CONSTRAINT transactions_currency_format
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');

ALTER TABLE transactions
  ADD CONSTRAINT transactions_date_format
    CHECK (transaction_date IS NULL OR transaction_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');

CREATE TABLE transaction_shipping (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions (id),
  carrier TEXT,
  service TEXT,
  tracking_number TEXT,
  shipment_date TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT transaction_shipping_transaction_id_key UNIQUE (transaction_id),
  CONSTRAINT transaction_shipping_date_format
    CHECK (shipment_date IS NULL OR shipment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

CREATE FUNCTION reject_finalized_transaction_mutation()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM proofs
     WHERE transaction_id = COALESCE(NEW.id, OLD.id)
       AND status = 'FINALIZED'
  ) THEN
    RAISE EXCEPTION 'PROOF_ALREADY_FINALIZED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_reject_finalized_update
  BEFORE UPDATE ON transactions
  FOR EACH ROW
  EXECUTE PROCEDURE reject_finalized_transaction_mutation();

CREATE FUNCTION reject_finalized_shipping_mutation()
RETURNS trigger AS $$
DECLARE
  txn_id TEXT;
BEGIN
  txn_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  IF EXISTS (
    SELECT 1 FROM proofs
     WHERE transaction_id = txn_id
       AND status = 'FINALIZED'
  ) THEN
    RAISE EXCEPTION 'PROOF_ALREADY_FINALIZED'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transaction_shipping_reject_finalized_insert
  BEFORE INSERT ON transaction_shipping
  FOR EACH ROW
  EXECUTE PROCEDURE reject_finalized_shipping_mutation();

CREATE TRIGGER transaction_shipping_reject_finalized_update
  BEFORE UPDATE ON transaction_shipping
  FOR EACH ROW
  EXECUTE PROCEDURE reject_finalized_shipping_mutation();

CREATE TRIGGER transaction_shipping_reject_finalized_delete
  BEFORE DELETE ON transaction_shipping
  FOR EACH ROW
  EXECUTE PROCEDURE reject_finalized_shipping_mutation();
