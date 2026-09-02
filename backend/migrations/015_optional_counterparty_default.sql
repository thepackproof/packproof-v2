-- Ordinary Proofs default to optional counterparty participation.
-- Existing rows keep the policy written at creation (immutable).

ALTER TABLE proofs
  ALTER COLUMN participation_policy SET DEFAULT 'COUNTERPARTY_OPTIONAL';
