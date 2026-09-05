-- Operational intake state is separate from immutable Proof evidence.
ALTER TABLE integration_connections ADD COLUMN auto_sync_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE commerce_connection_sync_states
  ADD COLUMN run_status text NOT NULL DEFAULT 'IDLE',
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN lease_token text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN next_run_at timestamptz,
  ADD COLUMN window_started_at timestamptz,
  ADD COLUMN window_ended_at timestamptz,
  ADD COLUMN initial_sync_completed_at timestamptz,
  ADD COLUMN last_reconciled_at timestamptz,
  ADD COLUMN reconciliation_pass boolean NOT NULL DEFAULT true,
  ADD COLUMN discovered_count integer NOT NULL DEFAULT 0,
  ADD COLUMN eligible_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT commerce_sync_status CHECK (run_status IN ('IDLE','RUNNING','RETRYING','FAILED'));
CREATE TABLE commerce_order_revisions (
  id text PRIMARY KEY,
  order_record_id text NOT NULL REFERENCES commerce_order_records(id),
  connection_id text NOT NULL REFERENCES integration_connections(id),
  fingerprint text NOT NULL,
  provider_updated_at timestamptz,
  observed_at timestamptz NOT NULL,
  mapping_version text NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('APPLIED','STALE','SUPPLEMENT')),
  normalized_order jsonb NOT NULL,
  UNIQUE(order_record_id,fingerprint)
);
CREATE FUNCTION protect_commerce_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Commerce source revisions are append-only'; END $$;
CREATE TRIGGER commerce_revision_append_only BEFORE UPDATE OR DELETE ON commerce_order_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_commerce_revision();
CREATE TABLE commerce_webhook_inbox (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES integration_connections(id),
  provider text NOT NULL,
  delivery_id text NOT NULL,
  topic text NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  UNIQUE(provider,delivery_id)
);
CREATE INDEX commerce_sync_due ON commerce_connection_sync_states(next_run_at);
CREATE INDEX commerce_revision_order ON commerce_order_revisions(order_record_id,observed_at);
