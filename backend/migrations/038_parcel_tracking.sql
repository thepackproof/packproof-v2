-- Single-parcel pilot declarations preserve their exact authorized item snapshot.
CREATE TABLE proof_parcel_scopes (
  proof_id TEXT PRIMARY KEY REFERENCES proofs(id),
  parcel_id TEXT NOT NULL UNIQUE,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  order_snapshot_sha256 TEXT NOT NULL,
  allocations JSONB NOT NULL,
  assurance TEXT NOT NULL CHECK(assurance='SELLER_DECLARED_SINGLE_PARCEL'),
  declared_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER proof_parcel_scopes_immutable BEFORE UPDATE OR DELETE ON proof_parcel_scopes FOR EACH ROW EXECUTE PROCEDURE protect_capture_shipping();
-- Decoding is an observation, including when association awaits confirmation.
CREATE TABLE capture_label_observations (
  id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES proofs(id),
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  tracking_number TEXT NOT NULL,
  carrier_hint TEXT,
  detected_at_ms INTEGER NOT NULL CHECK(detected_at_ms BETWEEN 0 AND 1800000),
  barcode_format TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  UNIQUE(session_id,tracking_number)
);
CREATE TRIGGER capture_label_observations_immutable BEFORE UPDATE OR DELETE ON capture_label_observations FOR EACH ROW EXECUTE PROCEDURE protect_capture_shipping();
-- Bounded hint inbox. No webhook body is promoted to a carrier fact.
CREATE TABLE shipment_notification_inbox (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  connection_id TEXT NOT NULL REFERENCES integration_connections(id),
  payload_sha256 TEXT NOT NULL,
  notification_bucket TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RECONCILED')),
  UNIQUE(transaction_id,notification_bucket)
);
CREATE INDEX shipment_notification_pending_idx ON shipment_notification_inbox(state,received_at);

-- Provider event identity is scoped to the immutable shipment transaction.
-- Reused tracking identifiers never move events between historical Proofs.
DROP INDEX shipment_events_provider_source_id_uq;
CREATE UNIQUE INDEX shipment_events_provider_source_id_uq ON shipment_events(transaction_id,provider,source_event_id) WHERE source_event_id IS NOT NULL;
