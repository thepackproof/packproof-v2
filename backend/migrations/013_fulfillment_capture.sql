-- Qualifying physical fulfillment capture is an evidence purpose, not a
-- Proof tier and not a MIME type. Existing SELLER_EVIDENCE rows stay valid
-- generic seller uploads. They do not satisfy merchant finalization.
-- Already-finalized Proofs are not rewritten.

ALTER TABLE evidence
  ADD CONSTRAINT evidence_type_check CHECK (
    evidence_type IN ('SELLER_EVIDENCE', 'FULFILLMENT_CAPTURE')
  );
