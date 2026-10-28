-- Read-only connection coverage projections. No state or retention mutation.
CREATE INDEX IF NOT EXISTS api_coverage_evidence_proof_status_idx
 ON evidence(proof_id,validation_status);
CREATE INDEX IF NOT EXISTS api_coverage_inbox_pending_idx
 ON commerce_webhook_inbox(connection_id,received_at) WHERE processed_at IS NULL;

-- Immutable external binding identity pages remain bounded for large histories.
CREATE INDEX IF NOT EXISTS api_binding_proof_page_idx
 ON platform_external_bindings(merchant_id,environment,proof_id,integration_account_id,resource_type,external_id);
