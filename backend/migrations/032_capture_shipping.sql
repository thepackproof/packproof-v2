-- Camera observations are append-only. Carrier observations remain in shipment_events.
CREATE TABLE capture_shipping_labels (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  carrier_hint TEXT,
  detected_at_ms INTEGER NOT NULL CHECK(detected_at_ms BETWEEN 0 AND 1800000),
  barcode_format TEXT NOT NULL,
  participant_confirmed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(session_id,idempotency_key),
  UNIQUE(session_id,tracking_number)
);
CREATE INDEX capture_shipping_proof_idx ON capture_shipping_labels(proof_id);
CREATE OR REPLACE FUNCTION protect_capture_shipping() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CAPTURE_SHIPPING_IMMUTABLE' USING ERRCODE='P0001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER capture_shipping_immutable BEFORE UPDATE OR DELETE ON capture_shipping_labels FOR EACH ROW EXECUTE PROCEDURE protect_capture_shipping();

-- Covers normal shipping edits and commerce imports as well as the scan endpoint.
CREATE OR REPLACE FUNCTION protect_captured_tracking() RETURNS trigger AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM capture_shipping_labels WHERE transaction_id=OLD.transaction_id)
     AND (TG_OP='DELETE' OR NEW.tracking_number IS DISTINCT FROM OLD.tracking_number OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id) THEN
    RAISE EXCEPTION 'CAPTURE_SHIPPING_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER captured_tracking_immutable BEFORE UPDATE OR DELETE ON transaction_shipping FOR EACH ROW EXECUTE PROCEDURE protect_captured_tracking();

CREATE TABLE capture_shipment_jobs (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK(state IN ('QUEUED','WAITING_FOR_CONNECTION','RETRY','REGISTERED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  last_error_code TEXT,
  carrier TEXT,
  provider_mode TEXT,
  registered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX capture_shipment_jobs_due_idx ON capture_shipment_jobs(next_run_at);
