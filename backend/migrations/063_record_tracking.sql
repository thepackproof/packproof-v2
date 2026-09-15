-- Carrier observations can refer to a later association without rewriting the packing context.
CREATE TABLE shipment_identity_registry (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id)
);
INSERT INTO shipment_identity_registry SELECT id,transaction_id FROM transaction_shipping;
CREATE FUNCTION register_shipment_identity() RETURNS trigger AS $$
BEGIN
  INSERT INTO shipment_identity_registry(id,transaction_id) VALUES(NEW.id,NEW.transaction_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER register_transaction_shipping AFTER INSERT ON transaction_shipping FOR EACH ROW EXECUTE PROCEDURE register_shipment_identity();
ALTER TABLE shipment_events DROP CONSTRAINT shipment_events_shipping_id_fkey;
ALTER TABLE shipment_events ADD CONSTRAINT shipment_events_shipping_id_fkey FOREIGN KEY(shipping_id) REFERENCES shipment_identity_registry(id);
CREATE TABLE proof_tracking_associations (
  id TEXT PRIMARY KEY REFERENCES shipment_identity_registry(id),
  proof_id TEXT NOT NULL UNIQUE REFERENCES proofs(id),
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  tracking_number TEXT NOT NULL,
  carrier TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('PARTICIPANT_SUPPLIED','CARRIER_LINK','SHARED_TRACKING')),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER tracking_association_immutable BEFORE UPDATE OR DELETE ON proof_tracking_associations FOR EACH ROW EXECUTE PROCEDURE reject_integration_identity_mutation();
CREATE TRIGGER shipment_registry_immutable BEFORE UPDATE OR DELETE ON shipment_identity_registry FOR EACH ROW EXECUTE PROCEDURE reject_integration_identity_mutation();
