-- Every Proof is interpreted under the workflow semantics that existed when
-- it was created. New protocol revisions must be additive; finalized and
-- historical Proofs are never retroactively reinterpreted.

ALTER TABLE proofs
  ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE proofs
  ADD CONSTRAINT proofs_workflow_version_check CHECK (workflow_version > 0);

CREATE FUNCTION reject_workflow_version_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW.workflow_version IS DISTINCT FROM OLD.workflow_version THEN
    RAISE EXCEPTION 'WORKFLOW_VERSION_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proofs_workflow_version_immutable
  BEFORE UPDATE ON proofs
  FOR EACH ROW
  EXECUTE PROCEDURE reject_workflow_version_mutation();
