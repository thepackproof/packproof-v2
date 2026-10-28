-- Additive read-model indexes. No Proof or evidence rows are changed.
CREATE INDEX api_proof_search_tenant_id ON api_tenant_proofs(tenant_id,proof_id DESC);
CREATE INDEX platform_proof_search_merchant_id ON platform_proof_ownership(merchant_id,environment,proof_id DESC);
CREATE INDEX proof_search_created_id ON proofs(created_at,id DESC);
CREATE INDEX proof_search_evidence ON evidence(proof_id,validation_status,committed_at,id);
CREATE INDEX proof_search_attestations ON attestations(proof_id,statement);
CREATE INDEX proof_search_root_capture ON capture_sessions(proof_id,state,recover_until) WHERE stage_id IS NULL;
CREATE INDEX proof_search_order_bindings ON platform_external_bindings(proof_id,integration_account_id,resource_type);
CREATE INDEX proof_search_recovery_proof ON recovery_events(proof_id,operation_id);
