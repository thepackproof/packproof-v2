-- Once an evidence row is committed, every field and the row itself are immutable.
-- The PENDING -> COMMITTED transition is unaffected because OLD.committed_at is null.

CREATE OR REPLACE FUNCTION reject_committed_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EVIDENCE_ALREADY_COMMITTED'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_reject_committed_delete
  BEFORE DELETE ON evidence
  FOR EACH ROW
  WHEN (OLD.committed_at IS NOT NULL)
  EXECUTE PROCEDURE reject_committed_evidence_mutation();
