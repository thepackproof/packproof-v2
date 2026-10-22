-- Additive, inactive merchant review records. No external submission authority.
CREATE TABLE claim_cases (
 id TEXT PRIMARY KEY,
 proof_id TEXT NOT NULL,
 merchant_id TEXT NOT NULL,
 environment TEXT NOT NULL,
 integration_account_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 provider_account_id TEXT NOT NULL,
 dispute_id TEXT NOT NULL,
 payment_id TEXT NOT NULL,
 order_line_ids JSONB NOT NULL CHECK(jsonb_typeof(order_line_ids)='array'),
 created_by TEXT NOT NULL REFERENCES users(id),
 create_key TEXT NOT NULL,
 create_request_sha256 TEXT NOT NULL CHECK(create_request_sha256 ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(proof_id,merchant_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 FOREIGN KEY(integration_account_id,merchant_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 UNIQUE(integration_account_id,dispute_id),
 UNIQUE(proof_id,created_by,create_key),
 UNIQUE(id,proof_id)
);
CREATE TABLE claim_case_revisions (
 id TEXT PRIMARY KEY,
 claim_case_id TEXT NOT NULL,
 proof_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 previous_sha256 TEXT CHECK(previous_sha256 ~ '^[a-f0-9]{64}$'),
 idempotency_key TEXT NOT NULL,
 request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 snapshot_json TEXT NOT NULL,
 snapshot_sha256 TEXT NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_by TEXT NOT NULL REFERENCES users(id),
 recorded_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(claim_case_id,proof_id) REFERENCES claim_cases(id,proof_id),
 UNIQUE(claim_case_id,revision),
 UNIQUE(claim_case_id,idempotency_key),
 CHECK((revision=1)=(previous_sha256 IS NULL))
);
CREATE INDEX claim_cases_proof ON claim_cases(proof_id,id);
CREATE TRIGGER claim_cases_immutable BEFORE UPDATE OR DELETE ON claim_cases FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TRIGGER claim_case_revisions_immutable BEFORE UPDATE OR DELETE ON claim_case_revisions FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
-- Runtime grants, protected export objects and activation require separate review.
