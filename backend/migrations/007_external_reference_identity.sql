-- One tenant may establish at most one identity binding on a Proof.
-- tenant + external transaction ID remains the lookup key.
-- (proof_id, tenant_key) prevents a second identity from replacing or shadowing the first.

CREATE UNIQUE INDEX proof_external_references_proof_tenant_uq
  ON proof_external_references (proof_id, tenant_key);
