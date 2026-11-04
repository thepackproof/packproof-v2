-- The existing deletion request is authoritative. Additional context never
-- deletes evidence or weakens retention policy, protected storage or restore gates.
CREATE TABLE record_deletion_contexts (
 request_id TEXT PRIMARY KEY REFERENCES proof_deletion_requests(id), proof_id TEXT NOT NULL REFERENCES proofs(id),
 organization_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('HUMAN','PARTNER')), actor_context JSONB NOT NULL,
 requested_revision INTEGER NOT NULL CHECK(requested_revision>0), impact_json JSONB NOT NULL,
 impact_sha256 TEXT NOT NULL CHECK(impact_sha256 ~ '^[a-f0-9]{64}$'), created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment)
);
CREATE TABLE record_deletion_reviews (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES record_deletion_contexts(request_id),
 decision TEXT NOT NULL CHECK(decision IN ('APPROVE','CANCEL')), reason TEXT NOT NULL,
 impact_sha256 TEXT NOT NULL CHECK(impact_sha256 ~ '^[a-f0-9]{64}$'), actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER record_deletion_context_immutable BEFORE UPDATE OR DELETE ON record_deletion_contexts FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_deletion_review_immutable BEFORE UPDATE OR DELETE ON record_deletion_reviews FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE INDEX record_deletion_context_scope ON record_deletion_contexts(organization_id,environment,created_at,request_id);
