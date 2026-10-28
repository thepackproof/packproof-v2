-- Read-only connection coverage projections. No state or retention mutation.
CREATE INDEX IF NOT EXISTS api_coverage_evidence_proof_status_idx
 ON evidence(proof_id,validation_status);
CREATE INDEX IF NOT EXISTS api_coverage_inbox_pending_idx
 ON commerce_webhook_inbox(connection_id,received_at) WHERE processed_at IS NULL;
