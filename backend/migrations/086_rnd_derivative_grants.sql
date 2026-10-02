CREATE TABLE rnd_derivative_grants (
 id TEXT PRIMARY KEY,
 proof_id TEXT NOT NULL REFERENCES proofs(id),
 analysis_id TEXT NOT NULL REFERENCES rnd_analyses(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 tenant_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 request_key_hash TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 artifact_sha256 TEXT NOT NULL,
 recipe_sha256 TEXT NOT NULL,
 review_id TEXT NOT NULL REFERENCES rnd_derivative_reviews(id),
 review_digest TEXT NOT NULL,
 canonical_json TEXT NOT NULL,
 digest TEXT NOT NULL,
 signature JSONB NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(proof_id,actor_id,request_key_hash),
 CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '1 day')
);
CREATE INDEX rnd_derivative_grants_analysis ON rnd_derivative_grants(proof_id,analysis_id,created_at);
CREATE TRIGGER rnd_derivative_grant_immutable BEFORE UPDATE OR DELETE ON rnd_derivative_grants FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TABLE rnd_derivative_grant_events (
 id TEXT PRIMARY KEY,
 grant_id TEXT NOT NULL REFERENCES rnd_derivative_grants(id),
 actor_id TEXT REFERENCES users(id),
 kind TEXT NOT NULL CHECK (kind IN ('CREATED','REVOKED','REDEEM_STARTED','REDEEM_COMPLETED','REDEEM_ABORTED')),
 canonical_json TEXT NOT NULL,
 digest TEXT NOT NULL,
 signature JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX rnd_derivative_grant_revoked ON rnd_derivative_grant_events(grant_id) WHERE kind='REVOKED';
CREATE INDEX rnd_derivative_grant_audit ON rnd_derivative_grant_events(grant_id,created_at,id);
CREATE TRIGGER rnd_derivative_grant_event_immutable BEFORE UPDATE OR DELETE ON rnd_derivative_grant_events FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
