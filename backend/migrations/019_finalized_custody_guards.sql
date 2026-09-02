-- Defense in depth: no custody record may be inserted, updated, or deleted
-- after its owning Proof has been finalized. Access-link lifecycle is excluded
-- because revocation and access counters intentionally continue after finalization.

CREATE FUNCTION reject_finalized_custody_write()
RETURNS trigger AS $$
DECLARE
  owner_proof_id TEXT;
BEGIN
  owner_proof_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.proof_id ELSE NEW.proof_id END;
  IF EXISTS (SELECT 1 FROM proofs WHERE id = owner_proof_id AND status = 'FINALIZED') THEN
    RAISE EXCEPTION 'PROOF_ALREADY_FINALIZED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proof_assets_reject_finalized_write
  BEFORE INSERT OR UPDATE OR DELETE ON proof_assets
  FOR EACH ROW EXECUTE PROCEDURE reject_finalized_custody_write();

CREATE TRIGGER proof_asset_external_refs_reject_finalized_write
  BEFORE INSERT OR UPDATE OR DELETE ON proof_asset_external_refs
  FOR EACH ROW EXECUTE PROCEDURE reject_finalized_custody_write();

CREATE TRIGGER custody_observations_reject_finalized_write
  BEFORE INSERT OR UPDATE OR DELETE ON custody_observations
  FOR EACH ROW EXECUTE PROCEDURE reject_finalized_custody_write();

CREATE TRIGGER custody_transfers_reject_finalized_write
  BEFORE INSERT OR UPDATE OR DELETE ON custody_transfers
  FOR EACH ROW EXECUTE PROCEDURE reject_finalized_custody_write();

CREATE TRIGGER continuity_evaluations_reject_finalized_write
  BEFORE INSERT OR UPDATE OR DELETE ON continuity_evaluations
  FOR EACH ROW EXECUTE PROCEDURE reject_finalized_custody_write();

CREATE FUNCTION reject_finalized_observation_join_write()
RETURNS trigger AS $$
DECLARE
  observation_key TEXT;
BEGIN
  observation_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.observation_id ELSE NEW.observation_id END;
  IF EXISTS (
    SELECT 1
      FROM custody_observations o
      JOIN proofs p ON p.id = o.proof_id
     WHERE o.id = observation_key
       AND p.status = 'FINALIZED'
  ) THEN
    RAISE EXCEPTION 'PROOF_ALREADY_FINALIZED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER observation_assets_reject_finalized_write
  BEFORE INSERT OR UPDATE OR DELETE ON observation_assets
  FOR EACH ROW EXECUTE PROCEDURE reject_finalized_observation_join_write();

CREATE TRIGGER observation_evidence_reject_finalized_write
  BEFORE INSERT OR UPDATE OR DELETE ON observation_evidence
  FOR EACH ROW EXECUTE PROCEDURE reject_finalized_observation_join_write();

CREATE TRIGGER observation_external_refs_reject_finalized_write
  BEFORE INSERT OR UPDATE OR DELETE ON observation_external_refs
  FOR EACH ROW EXECUTE PROCEDURE reject_finalized_observation_join_write();

CREATE TRIGGER observation_external_refs_immutable_update
  BEFORE UPDATE ON observation_external_refs
  FOR EACH ROW EXECUTE PROCEDURE reject_observation_mutation();

CREATE TRIGGER observation_external_refs_immutable_delete
  BEFORE DELETE ON observation_external_refs
  FOR EACH ROW EXECUTE PROCEDURE reject_observation_mutation();
