-- Preserve every financial leg; never rewrite a previously accepted refund.
ALTER TABLE billing_payment_ledger DROP CONSTRAINT billing_payment_ledger_kind_check;
ALTER TABLE billing_payment_ledger ADD CONSTRAINT billing_payment_ledger_kind_check
 CHECK(kind IN ('payment_settled','refund_settled','refund_reversed'));
CREATE FUNCTION validate_billing_refund_reversal() RETURNS trigger AS $$
BEGIN
 IF NEW.kind='refund_reversed' AND NOT EXISTS (
  SELECT 1 FROM billing_payment_ledger d WHERE d.provider=NEW.provider
   AND d.environment=NEW.environment AND d.provider_account=NEW.provider_account
   AND d.subject_reference=NEW.subject_reference AND d.kind='refund_settled'
   AND d.payment_reference=NEW.payment_reference AND d.user_id=NEW.user_id
   AND d.amount_minor=NEW.amount_minor AND d.currency=NEW.currency AND d.occurred_at<=NEW.occurred_at
 ) THEN RAISE EXCEPTION 'BILLING_REFUND_RECONCILIATION_REQUIRED'; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER billing_refund_reversal_requires_debit BEFORE INSERT ON billing_payment_ledger
 FOR EACH ROW EXECUTE PROCEDURE validate_billing_refund_reversal();
