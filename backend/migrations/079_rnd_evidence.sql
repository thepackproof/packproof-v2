-- Experimental additive evidence. Ordinary capture/finalization never depends on these tables.
CREATE TABLE rnd_subjects (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), tenant_id TEXT NOT NULL,
 leg_id TEXT NOT NULL, package_instance_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(proof_id,leg_id), UNIQUE(id,proof_id,tenant_id)
);
CREATE TABLE rnd_consents (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), actor_id TEXT NOT NULL REFERENCES users(id),
 purpose TEXT NOT NULL CHECK(purpose IN ('EXPERIMENTAL_ANALYSIS','LEARNING')),
 version TEXT NOT NULL, granted BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX rnd_consent_latest ON rnd_consents(proof_id,actor_id,purpose,created_at DESC,id DESC);
CREATE TABLE rnd_intents (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), tenant_id TEXT NOT NULL,
 subject_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), nonce_hash TEXT NOT NULL UNIQUE,
 canonical_json TEXT NOT NULL, digest TEXT NOT NULL, signature JSONB NOT NULL,
 acquisition_mode TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(subject_id,proof_id,tenant_id) REFERENCES rnd_subjects(id,proof_id,tenant_id)
);
CREATE TABLE rnd_session_starts (
 intent_id TEXT PRIMARY KEY REFERENCES rnd_intents(id), capture_session_id TEXT NOT NULL UNIQUE REFERENCES capture_sessions(id),
 request_digest TEXT NOT NULL, client_public_key_pem TEXT, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE rnd_session_receipts (
 intent_id TEXT PRIMARY KEY REFERENCES rnd_intents(id), canonical_json TEXT NOT NULL, digest TEXT NOT NULL,
 signature JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE rnd_sources (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), tenant_id TEXT NOT NULL, subject_id TEXT NOT NULL,
 evidence_id TEXT NOT NULL UNIQUE, leg_id TEXT NOT NULL, capture_session_id TEXT,
 object_key TEXT NOT NULL, object_version_id TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_length BIGINT NOT NULL CHECK(byte_length>0), mime_type TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(object_key,object_version_id), UNIQUE(id,proof_id,tenant_id),
 FOREIGN KEY(subject_id,proof_id,tenant_id) REFERENCES rnd_subjects(id,proof_id,tenant_id)
);
CREATE TABLE rnd_analyses (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
 feature TEXT NOT NULL, identity_digest TEXT NOT NULL, root_digest TEXT NOT NULL, input_json JSONB NOT NULL,
 operational_state TEXT NOT NULL CHECK(operational_state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
 attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
 available_at TIMESTAMPTZ NOT NULL, lease_token TEXT, lease_until TIMESTAMPTZ,
 error_code TEXT, result_json JSONB, created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
 UNIQUE(tenant_id,identity_digest), UNIQUE(id,proof_id,tenant_id),
 CHECK((operational_state='SUCCEEDED')=(result_json IS NOT NULL))
);
CREATE INDEX rnd_jobs_ready ON rnd_analyses(operational_state,available_at,lease_until);
CREATE TABLE rnd_extensions (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL REFERENCES proofs(id), tenant_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0), previous_digest TEXT, root_digest TEXT NOT NULL,
 analysis_id TEXT NOT NULL UNIQUE, canonical_json TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
 signature JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(proof_id,sequence), FOREIGN KEY(analysis_id,proof_id,tenant_id) REFERENCES rnd_analyses(id,proof_id,tenant_id)
);
CREATE TABLE rnd_idempotency (
 tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), operation TEXT NOT NULL,
 key_hash TEXT NOT NULL, request_digest TEXT NOT NULL, response_json JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(tenant_id,actor_id,operation,key_hash)
);
CREATE TABLE rnd_live_challenges (
 id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES rnd_intents(id), proof_id TEXT NOT NULL REFERENCES proofs(id),
 actor_id TEXT NOT NULL REFERENCES users(id), canonical_json TEXT NOT NULL, digest TEXT NOT NULL,
 signature JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE rnd_live_responses (
 challenge_id TEXT PRIMARY KEY REFERENCES rnd_live_challenges(id), analysis_id TEXT NOT NULL UNIQUE REFERENCES rnd_analyses(id),
 source_id TEXT NOT NULL REFERENCES rnd_sources(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE rnd_derivative_reviews (
 id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES rnd_analyses(id), actor_id TEXT NOT NULL REFERENCES users(id),
 artifact_sha256 TEXT NOT NULL, recipe_sha256 TEXT NOT NULL, approved BOOLEAN NOT NULL,
 canonical_json TEXT NOT NULL, digest TEXT NOT NULL, signature JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER rnd_review_immutable BEFORE UPDATE OR DELETE ON rnd_derivative_reviews FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION rnd_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'RND_RECORD_IMMUTABLE'; END;
$$;
CREATE TRIGGER rnd_subject_immutable BEFORE UPDATE OR DELETE ON rnd_subjects FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_consent_immutable BEFORE UPDATE OR DELETE ON rnd_consents FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_intent_immutable BEFORE UPDATE OR DELETE ON rnd_intents FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_start_immutable BEFORE UPDATE OR DELETE ON rnd_session_starts FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_receipt_immutable BEFORE UPDATE OR DELETE ON rnd_session_receipts FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_source_immutable BEFORE UPDATE OR DELETE ON rnd_sources FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_extension_immutable BEFORE UPDATE OR DELETE ON rnd_extensions FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_idempotency_immutable BEFORE UPDATE OR DELETE ON rnd_idempotency FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_challenge_immutable BEFORE UPDATE OR DELETE ON rnd_live_challenges FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE TRIGGER rnd_response_immutable BEFORE UPDATE OR DELETE ON rnd_live_responses FOR EACH ROW EXECUTE FUNCTION rnd_immutable();
CREATE FUNCTION rnd_analysis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.operational_state IN ('SUCCEEDED','FAILED','CANCELLED') THEN RAISE EXCEPTION 'RND_RECORD_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['operational_state','attempts','available_at','lease_token','lease_until','error_code','result_json','completed_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['operational_state','attempts','available_at','lease_token','lease_until','error_code','result_json','completed_at'])
 THEN RAISE EXCEPTION 'RND_ANALYSIS_BINDING_IMMUTABLE'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER rnd_analysis_immutable BEFORE UPDATE OR DELETE ON rnd_analyses FOR EACH ROW EXECUTE FUNCTION rnd_analysis_guard();
