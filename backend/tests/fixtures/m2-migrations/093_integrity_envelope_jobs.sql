-- Additive, opt-in signing work. Historical manifests and receipts are untouched.
-- Requests/results are accepted facts; leases are a rebuildable projection.
CREATE TABLE integrity_envelope_jobs (
 operation_id TEXT PRIMARY KEY,
 proof_id TEXT NOT NULL REFERENCES proofs(id),
 record_type TEXT NOT NULL CHECK(record_type IN ('CORE','STAGE','SUPPLEMENT')),
 record_id TEXT NOT NULL,
 manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 request_json TEXT NOT NULL,
 request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(proof_id,record_type,record_id,manifest_sha256)
);
CREATE TRIGGER integrity_envelope_jobs_no_change BEFORE UPDATE OR DELETE ON integrity_envelope_jobs
 FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TABLE integrity_envelope_delivery (
 operation_id TEXT PRIMARY KEY REFERENCES integrity_envelope_jobs(operation_id),
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','ACCEPTED','DEAD_LETTER')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT,
 lease_until TIMESTAMPTZ,
 error_code TEXT
);
CREATE INDEX integrity_envelope_work ON integrity_envelope_delivery(state,next_attempt_at,lease_until);
CREATE TABLE integrity_envelope_results (
 operation_id TEXT PRIMARY KEY REFERENCES integrity_envelope_jobs(operation_id),
 proof_id TEXT NOT NULL REFERENCES proofs(id),
 bundle_json TEXT NOT NULL,
 bundle_sha256 TEXT NOT NULL CHECK(bundle_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_json JSONB NOT NULL,
 accepted_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER integrity_envelope_results_no_change BEFORE UPDATE OR DELETE ON integrity_envelope_results
 FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
-- No runtime grants or activation are implied by this migration. A scoped
-- worker grant and a reviewed protection/authority receipt are separate gates.
