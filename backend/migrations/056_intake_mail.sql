-- Operational mail state is isolated from canonical Proof and evidence storage.
CREATE TABLE intake_mail_aliases (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id),
  connection_id text NOT NULL REFERENCES integration_connections(id),
  address text NOT NULL UNIQUE,
  provider text NOT NULL,
  external_account_reference text NOT NULL,
  state text NOT NULL CHECK (state IN ('AWAITING_VERIFICATION','AWAITING_VALID_SAMPLE','READY','REVOKED')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  verified_at timestamptz,
  sample_validated_at timestamptz,
  revoked_at timestamptz,
  last_received_at timestamptz,
  last_error_code text,
  challenge_id text,
  challenge_code text,
  challenge_url text,
  challenge_expires_at timestamptz
);
CREATE UNIQUE INDEX intake_mail_active_store ON intake_mail_aliases(owner_user_id,connection_id) WHERE state <> 'REVOKED';
CREATE TABLE intake_mail_receipts (
  id text PRIMARY KEY,
  alias_id text NOT NULL REFERENCES intake_mail_aliases(id),
  receipt_id text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  received_at timestamptz NOT NULL,
  transport_verdict text NOT NULL CHECK (transport_verdict IN ('PASS','SUSPICIOUS')),
  raw_sha256 text,
  parser_version text,
  outcome text,
  error_code text,
  processed_at timestamptz,
  UNIQUE(alias_id, receipt_id)
);
CREATE INDEX intake_mail_receipt_digest ON intake_mail_receipts(alias_id, raw_sha256);
CREATE TABLE intake_mail_jobs (
  receipt_id text PRIMARY KEY REFERENCES intake_mail_receipts(id),
  state text NOT NULL CHECK (state IN ('PENDING','RUNNING','RETRY','DONE','QUARANTINED')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  lease_token text,
  lease_expires_at timestamptz,
  replay_count integer NOT NULL DEFAULT 0,
  last_error_code text
);
CREATE INDEX intake_mail_jobs_due ON intake_mail_jobs(next_attempt_at) WHERE state IN ('PENDING','RUNNING','RETRY');
-- Source receipt identity cannot be repointed by retries or operational updates.
CREATE FUNCTION protect_intake_mail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.alias_id IS DISTINCT FROM OLD.alias_id OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
    OR NEW.bucket IS DISTINCT FROM OLD.bucket OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.transport_verdict IS DISTINCT FROM OLD.transport_verdict
    OR (OLD.raw_sha256 IS NOT NULL AND NEW.raw_sha256 IS DISTINCT FROM OLD.raw_sha256) THEN
    RAISE EXCEPTION 'MAIL_RECEIPT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER intake_mail_receipt_identity BEFORE UPDATE ON intake_mail_receipts FOR EACH ROW EXECUTE FUNCTION protect_intake_mail_receipt();

-- An alias keeps its approved store even when OAuth connection metadata changes.
CREATE FUNCTION protect_intake_mail_alias_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.address IS DISTINCT FROM OLD.address OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.external_account_reference IS DISTINCT FROM OLD.external_account_reference THEN
    RAISE EXCEPTION 'MAIL_ALIAS_SCOPE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER intake_mail_alias_scope BEFORE UPDATE ON intake_mail_aliases FOR EACH ROW EXECUTE FUNCTION protect_intake_mail_alias_scope();
