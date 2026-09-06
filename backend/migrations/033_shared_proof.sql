-- One live shared Proof replaces recipient-specific choices for new links.
-- Existing grants retain their reviewed scope and never gain new permissions.
ALTER TABLE proof_disclosure_grants
  DROP CONSTRAINT proof_disclosure_grants_purpose_check;
ALTER TABLE proof_disclosure_grants
  ADD CONSTRAINT proof_disclosure_grants_purpose_check
  CHECK (purpose IN ('BUYER_RECEIPT', 'CLAIMS_REVIEW', 'PUBLIC_SAMPLE', 'SHARED_PROOF'));
