-- Experimental append-only physical-surface evidence. No core Proof table changes.
CREATE TABLE surface_media (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), actor_user_id TEXT NOT NULL REFERENCES users(id),
 capture_session_id TEXT REFERENCES capture_sessions(id), idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 expected_sha256 TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK(byte_size BETWEEN 1 AND 8388608), content_type TEXT NOT NULL,
 object_key TEXT, object_version_id TEXT, sha256 TEXT, created_at TIMESTAMPTZ NOT NULL, committed_at TIMESTAMPTZ,
 UNIQUE(proof_id,actor_user_id,idempotency_key)
);
CREATE FUNCTION surface_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.committed_at IS NOT NULL OR NEW.proof_id<>OLD.proof_id OR NEW.actor_user_id<>OLD.actor_user_id OR NEW.request_sha256<>OLD.request_sha256 OR NEW.expected_sha256<>OLD.expected_sha256 OR NEW.byte_size<>OLD.byte_size OR NEW.content_type<>OLD.content_type OR NEW.capture_session_id IS DISTINCT FROM OLD.capture_session_id THEN RAISE EXCEPTION 'SURFACE_MEDIA_IMMUTABLE'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER surface_media_no_change BEFORE UPDATE OR DELETE ON surface_media FOR EACH ROW EXECUTE FUNCTION surface_media_guard();
CREATE TABLE surface_intents (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), actor_user_id TEXT NOT NULL REFERENCES users(id),
 operation TEXT NOT NULL CHECK(operation IN ('enrollment','observation','comparison')), request_sha256 TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_record_id TEXT
);
CREATE TABLE surface_records (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), tenant_scope TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('enrollment','observation','comparison')), package_instance_id TEXT NOT NULL, shipment_leg_id TEXT NOT NULL,
 enrollment_id TEXT REFERENCES surface_records(id), observation_id TEXT REFERENCES surface_records(id),
 idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, canonical_json TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(proof_id,actor_user_id,kind,idempotency_key)
);
CREATE UNIQUE INDEX surface_enrollment_baseline ON surface_records(proof_id,package_instance_id,shipment_leg_id) WHERE kind='enrollment';
CREATE TRIGGER surface_records_no_change BEFORE UPDATE OR DELETE ON surface_records FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TABLE surface_jobs (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), record_id TEXT NOT NULL UNIQUE REFERENCES surface_records(id),
 operation TEXT NOT NULL CHECK(operation IN ('extract','compare')), identity_sha256 TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','error')), attempts INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until TIMESTAMPTZ, available_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL, error_code TEXT
);
CREATE INDEX surface_jobs_ready ON surface_jobs(status,available_at);
CREATE TABLE surface_analyses (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), record_id TEXT NOT NULL UNIQUE REFERENCES surface_records(id),
 job_id TEXT NOT NULL UNIQUE REFERENCES surface_jobs(id), canonical_json TEXT NOT NULL, sha256 TEXT NOT NULL,
 private_result_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER surface_analyses_no_change BEFORE UPDATE OR DELETE ON surface_analyses FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
CREATE TABLE surface_extensions (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), sequence INTEGER NOT NULL, subject_id TEXT NOT NULL,
 canonical_json TEXT NOT NULL, sha256 TEXT NOT NULL, previous_sha256 TEXT, root_manifest_sha256 TEXT, signature_json JSONB,
 created_at TIMESTAMPTZ NOT NULL, UNIQUE(proof_id,sequence), UNIQUE(proof_id,subject_id)
);
CREATE TRIGGER surface_extensions_no_change BEFORE UPDATE OR DELETE ON surface_extensions FOR EACH ROW EXECUTE PROCEDURE reject_audit_mutation();
