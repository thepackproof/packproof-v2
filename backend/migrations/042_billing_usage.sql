-- W13: immutable metering and verified-provider accounting. This migration creates
-- no priced offer, customer subscription, charge, invoice or deletion entitlement.
CREATE TABLE billing_offer_versions (
  version TEXT PRIMARY KEY,
  definition_json JSONB NOT NULL,
  sha256 TEXT NOT NULL,
  approved_terms_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER billing_offer_versions_immutable BEFORE UPDATE OR DELETE ON billing_offer_versions
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();

CREATE TABLE billing_account_offer_periods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  offer_version TEXT NOT NULL REFERENCES billing_offer_versions(version),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  consent_receipt_reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK(period_start < period_end)
);
CREATE INDEX billing_account_offer_periods_account ON billing_account_offer_periods(user_id,period_start,period_end);
CREATE FUNCTION protect_billing_offer_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM billing_offer_versions WHERE version=NEW.offer_version AND approved_terms_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'BILLING_OFFER_NOT_APPROVED';
  END IF;
  IF EXISTS(SELECT 1 FROM billing_account_offer_periods WHERE user_id=NEW.user_id AND period_start < NEW.period_end AND period_end > NEW.period_start) THEN
    RAISE EXCEPTION 'BILLING_PERIOD_OVERLAP';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_offer_period_admission BEFORE INSERT ON billing_account_offer_periods
  FOR EACH ROW EXECUTE PROCEDURE protect_billing_offer_period();
CREATE TRIGGER billing_account_offer_periods_immutable BEFORE UPDATE OR DELETE ON billing_account_offer_periods
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();

CREATE TABLE billing_proof_usage (
  proof_id TEXT PRIMARY KEY REFERENCES proofs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  finalized_at TIMESTAMPTZ NOT NULL,
  preservation_operation_id TEXT NOT NULL UNIQUE REFERENCES recovery_events(operation_id),
  receipt_sha256 TEXT NOT NULL,
  offer_period_id TEXT REFERENCES billing_account_offer_periods(id),
  units INTEGER NOT NULL CHECK(units=1),
  charge_eligible BOOLEAN NOT NULL DEFAULT false,
  recorded_at TIMESTAMPTZ NOT NULL,
  CHECK(NOT charge_eligible OR offer_period_id IS NOT NULL)
);
CREATE INDEX billing_proof_usage_account ON billing_proof_usage(user_id,finalized_at);
CREATE FUNCTION protect_billing_usage_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM proofs p JOIN proof_participants pp ON pp.proof_id=p.id
    JOIN recovery_events e ON e.proof_id=p.id AND e.operation_id=NEW.preservation_operation_id
    JOIN recovery_delivery d ON d.operation_id=e.operation_id
    WHERE p.id=NEW.proof_id AND p.status='FINALIZED' AND pp.user_id=NEW.user_id AND pp.role='SELLER'
      AND e.kind='PROOF_FINALIZED' AND d.state='DURABLE' AND d.receipt_json IS NOT NULL
      AND d.receipt_json->>'operationId'=e.operation_id AND d.receipt_json->>'eventSha256'=e.sha256
      AND (d.receipt_json->>'preservedAt')::timestamptz=NEW.finalized_at) THEN
    RAISE EXCEPTION 'BILLING_DURABLE_FINALIZATION_REQUIRED';
  END IF;
  IF NEW.offer_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM billing_account_offer_periods
    WHERE id=NEW.offer_period_id AND user_id=NEW.user_id AND period_start<=NEW.finalized_at AND period_end>NEW.finalized_at) THEN
    RAISE EXCEPTION 'BILLING_OFFER_PERIOD_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_usage_admission BEFORE INSERT ON billing_proof_usage
  FOR EACH ROW EXECUTE PROCEDURE protect_billing_usage_admission();
CREATE TRIGGER billing_proof_usage_immutable BEFORE UPDATE OR DELETE ON billing_proof_usage
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();

CREATE TABLE billing_customer_bindings (
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
  provider_account TEXT NOT NULL,
  customer_reference TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(provider,environment,provider_account,customer_reference)
);
CREATE TRIGGER billing_customer_bindings_immutable BEFORE UPDATE OR DELETE ON billing_customer_bindings
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();

CREATE TABLE billing_provider_events (
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
  provider_account TEXT NOT NULL,
  event_reference TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  normalized_json JSONB NOT NULL,
  sha256 TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(provider,environment,provider_account,event_reference)
);
CREATE TRIGGER billing_provider_events_immutable BEFORE UPDATE OR DELETE ON billing_provider_events
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();

CREATE TABLE billing_payment_ledger (
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
  provider_account TEXT NOT NULL,
  subject_reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('payment_settled','refund_settled')),
  payment_reference TEXT NOT NULL,
  source_event_reference TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  amount_minor BIGINT NOT NULL CHECK(amount_minor>=0),
  currency TEXT NOT NULL CHECK(currency='USD'),
  sha256 TEXT NOT NULL,
  PRIMARY KEY(provider,environment,provider_account,subject_reference,kind)
);
CREATE INDEX billing_payment_ledger_account ON billing_payment_ledger(user_id,occurred_at);
CREATE TRIGGER billing_payment_ledger_immutable BEFORE UPDATE OR DELETE ON billing_payment_ledger
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
