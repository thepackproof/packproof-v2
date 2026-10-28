-- Add commit-safe notifications for source mutations required by reconciliation.
-- Existing event names, IDs, ordering and immutable historical outbox rows remain
-- untouched. The originating audit retains human/integration provenance; the
-- public event only requests an authorized refresh of the current Proof.
CREATE FUNCTION publish_api_projection_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type IN (
    'PARTICIPANT_INVITED',
    'PROOF_FINALIZATION_PREPARED',
    'TRANSACTION_DETAILS_UPDATED',
    'SHIPPING_DETAILS_UPDATED',
    'SHIPPING_DETAILS_IMPORTED',
    'TRANSACTION_SOURCE_OBSERVED'
  ) THEN
    INSERT INTO proof_outbox(id,proof_id,audit_id,event_type,created_at)
    VALUES(NEW.id || ':proof.updated',NEW.proof_id,NEW.id,'proof.updated',NEW.created_at);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER api_projection_update_on_audit AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION publish_api_projection_update();
