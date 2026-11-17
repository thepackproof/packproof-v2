-- Existing receipts keep their original interpretation. Only new qualified
-- shipment receipts receive a decision in the same transaction as their rows.
ALTER TABLE partner_import_jobs ADD COLUMN shipment_interpretation JSONB;

CREATE FUNCTION protect_shipment_interpretation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shipment_interpretation IS DISTINCT FROM OLD.shipment_interpretation THEN
    RAISE EXCEPTION 'An admitted shipment interpretation is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_import_shipment_interpretation_immutable
BEFORE UPDATE OF shipment_interpretation ON partner_import_jobs
FOR EACH ROW EXECUTE FUNCTION protect_shipment_interpretation();
