-- Optional enrollment only. No offer, customer, subscription or price is seeded.
ALTER TABLE capture_sessions ADD COLUMN max_recording_bytes BIGINT CHECK(max_recording_bytes>0);
CREATE FUNCTION protect_capture_billing_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.max_recording_bytes IS DISTINCT FROM OLD.max_recording_bytes OR NEW.max_duration_ms IS DISTINCT FROM OLD.max_duration_ms THEN RAISE EXCEPTION 'CAPTURE_RECORDING_LIMIT_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_billing_limit BEFORE UPDATE ON capture_sessions FOR EACH ROW EXECUTE PROCEDURE protect_capture_billing_limit();
CREATE TABLE billing_checkout_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider_account TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
  offer_version TEXT NOT NULL REFERENCES billing_offer_versions(version),
  offer_sha256 TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  consent_at TIMESTAMPTZ NOT NULL,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  session_reference TEXT UNIQUE,
  checkout_url TEXT,
  expires_at TIMESTAMPTZ,
  subscription_reference TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('PENDING','OPEN','COMPLETE','EXPIRED')),
  UNIQUE(user_id,provider_account,environment,operation_key)
);
CREATE UNIQUE INDEX billing_checkout_one_open ON billing_checkout_operations(user_id,provider_account,environment)
  WHERE state IN ('PENDING','OPEN');
CREATE FUNCTION protect_billing_checkout_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.user_id,NEW.provider_account,NEW.environment,NEW.offer_version,NEW.offer_sha256,NEW.operation_key,NEW.consent_at)
    IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.provider_account,OLD.environment,OLD.offer_version,OLD.offer_sha256,OLD.operation_key,OLD.consent_at)
    OR (OLD.session_reference IS NOT NULL AND NEW.session_reference IS DISTINCT FROM OLD.session_reference)
    OR (OLD.subscription_reference IS NOT NULL AND NEW.subscription_reference IS DISTINCT FROM OLD.subscription_reference)
    OR (OLD.state='COMPLETE' AND NEW.state<>'COMPLETE') THEN RAISE EXCEPTION 'BILLING_CHECKOUT_IDENTITY_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_checkout_identity BEFORE UPDATE ON billing_checkout_operations
  FOR EACH ROW EXECUTE PROCEDURE protect_billing_checkout_identity();
CREATE TRIGGER billing_checkout_no_delete BEFORE DELETE ON billing_checkout_operations
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();

CREATE TABLE billing_capture_reservations (
  proof_id TEXT PRIMARY KEY REFERENCES proofs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  offer_period_id TEXT NOT NULL REFERENCES billing_account_offer_periods(id),
  reserved_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX billing_capture_reservations_period ON billing_capture_reservations(offer_period_id);
CREATE TRIGGER billing_capture_reservations_immutable BEFORE UPDATE OR DELETE ON billing_capture_reservations
  FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
