CREATE TABLE recipient_export_jobs (
 id TEXT PRIMARY KEY,
 proof_id TEXT NOT NULL REFERENCES proofs(id),
 case_id TEXT NOT NULL REFERENCES signature_cases(id),
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 idempotency_key TEXT NOT NULL,
 request_json TEXT NOT NULL,
 request_sha256 TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('QUEUED','RENDERING','READY','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL,
 completed_at TIMESTAMPTZ,
 failure_code TEXT,
 artifact_json TEXT,
 artifact_sha256 TEXT,
 UNIQUE(proof_id,actor_user_id,idempotency_key)
);
CREATE INDEX recipient_export_jobs_due_idx ON recipient_export_jobs(state,lease_until,created_at);
CREATE TABLE recipient_export_approvals (
 job_id TEXT PRIMARY KEY REFERENCES recipient_export_jobs(id),
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 artifact_sha256 TEXT NOT NULL,
 approved_at TIMESTAMPTZ NOT NULL,
 legibility_confirmed BOOLEAN NOT NULL CHECK(legibility_confirmed)
);
CREATE TRIGGER recipient_export_approvals_immutable BEFORE UPDATE OR DELETE ON recipient_export_approvals FOR EACH ROW EXECUTE PROCEDURE protect_capture_shipping();
CREATE OR REPLACE FUNCTION protect_recipient_export_job() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.request_json IS DISTINCT FROM OLD.request_json OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256 OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.proof_id IS DISTINCT FROM OLD.proof_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.profile_id IS DISTINCT FROM OLD.profile_id OR (OLD.state='READY' AND (NEW.artifact_json IS DISTINCT FROM OLD.artifact_json OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256 OR NEW.state IS DISTINCT FROM OLD.state)) THEN RAISE EXCEPTION 'RECIPIENT_EXPORT_IMMUTABLE' USING ERRCODE='P0001'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER recipient_export_job_immutable BEFORE UPDATE OR DELETE ON recipient_export_jobs FOR EACH ROW EXECUTE PROCEDURE protect_recipient_export_job();
