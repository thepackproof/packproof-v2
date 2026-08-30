-- Lookup authorized Proofs by authenticated participant without a new ownership table.
CREATE INDEX proof_participants_user_id_idx
  ON proof_participants (user_id);
