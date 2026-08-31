-- Append-only shipment observations.
-- transaction_shipping remains shipment identity (carrier, service, tracking, date).
-- These rows are observations about that identity. They may arrive after FINALIZED.
-- They must never mutate transaction facts, shipping identity, evidence, or the core manifest.

CREATE TABLE shipment_events (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs (id),
  transaction_id TEXT NOT NULL REFERENCES transactions (id),
  shipping_id TEXT NOT NULL REFERENCES transaction_shipping (id),
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  carrier TEXT,
  location_text TEXT,
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_event_id TEXT,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_sha256 TEXT,
  content_sha256 TEXT NOT NULL,
  previous_event_sha256 TEXT,
  core_manifest_sha256 TEXT,
  sha256 TEXT NOT NULL,
  dedupe_fingerprint TEXT NOT NULL,
  CONSTRAINT shipment_events_type_check CHECK (
    event_type IN (
      'LABEL_CREATED',
      'CARRIER_ACCEPTED',
      'WEIGHT_RECORDED',
      'IN_TRANSIT',
      'ARRIVED_AT_FACILITY',
      'DEPARTED_FACILITY',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'DELIVERY_EXCEPTION',
      'RETURN_TO_SENDER',
      'RETURN_IN_TRANSIT',
      'RETURN_DELIVERED',
      'CARRIER_EVENT'
    )
  ),
  CONSTRAINT shipment_events_source_check CHECK (
    source IN (
      'MARKETPLACE_API',
      'STOREFRONT_API',
      'SHIPPING_PROVIDER_API',
      'LABEL_SCAN',
      'PARTICIPANT_SUPPLIED'
    )
  ),
  CONSTRAINT shipment_events_payload_sha256_format CHECK (
    payload_sha256 IS NULL OR payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT shipment_events_content_sha256_format CHECK (
    content_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT shipment_events_sha256_format CHECK (
    sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT shipment_events_previous_sha256_format CHECK (
    previous_event_sha256 IS NULL OR previous_event_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT shipment_events_core_manifest_sha256_format CHECK (
    core_manifest_sha256 IS NULL OR core_manifest_sha256 ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX shipment_events_provider_source_id_uq
  ON shipment_events (provider, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE UNIQUE INDEX shipment_events_txn_fingerprint_uq
  ON shipment_events (transaction_id, dedupe_fingerprint)
  WHERE source_event_id IS NULL;

CREATE INDEX shipment_events_proof_occurred_idx
  ON shipment_events (proof_id, occurred_at, id);

CREATE INDEX shipment_events_txn_occurred_idx
  ON shipment_events (transaction_id, occurred_at, id);

CREATE INDEX shipment_events_shipping_created_idx
  ON shipment_events (shipping_id, created_at, id);

CREATE FUNCTION reject_shipment_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SHIPMENT_EVENT_IMMUTABLE'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipment_events_immutable_update
  BEFORE UPDATE ON shipment_events
  FOR EACH ROW
  EXECUTE PROCEDURE reject_shipment_event_mutation();

CREATE TRIGGER shipment_events_immutable_delete
  BEFORE DELETE ON shipment_events
  FOR EACH ROW
  EXECUTE PROCEDURE reject_shipment_event_mutation();
