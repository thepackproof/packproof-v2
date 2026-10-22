-- Additive, inactive protected-artifact receipts. No legacy file backfill.
ALTER TABLE recipient_export_jobs ADD CONSTRAINT recipient_export_job_proof UNIQUE(id,proof_id);
CREATE TABLE recipient_export_preservations (
 job_id TEXT PRIMARY KEY,
 proof_id TEXT NOT NULL,
 request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 artifact_sha256 TEXT NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_json JSONB NOT NULL CHECK(jsonb_typeof(receipt_json)='object'),
 accepted_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(job_id,proof_id) REFERENCES recipient_export_jobs(id,proof_id)
);
CREATE TRIGGER recipient_export_preservation_immutable BEFORE UPDATE OR DELETE ON recipient_export_preservations FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE OR REPLACE FUNCTION protect_recipient_export_job() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at IS DISTINCT FROM OLD.created_at
 OR NEW.request_json IS DISTINCT FROM OLD.request_json OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256 OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
 OR NEW.proof_id IS DISTINCT FROM OLD.proof_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
 OR (OLD.state IN ('READY','FAILED') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'RECIPIENT_EXPORT_IMMUTABLE' USING ERRCODE='P0001'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
-- Runtime grants and actual-role storage acceptance remain separate activation gates.
