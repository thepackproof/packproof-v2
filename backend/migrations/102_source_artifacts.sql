-- Organization submitted originals are operational attachments. They never
-- modify frozen capture evidence, declarations or human capture assurance.
CREATE TABLE record_source_artifacts (
 id TEXT PRIMARY KEY, proof_id TEXT NOT NULL, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 connection_id TEXT, connection_revision BIGINT NOT NULL CHECK(connection_revision>=0), source_artifact_id TEXT NOT NULL,
 filename TEXT NOT NULL, content_type TEXT NOT NULL, declared_byte_size BIGINT NOT NULL CHECK(declared_byte_size BETWEEN 1 AND 250000000),
 expected_sha256 TEXT CHECK(expected_sha256 ~ '^[a-f0-9]{64}$'), subject_id TEXT NOT NULL,
 reported_at TIMESTAMPTZ NOT NULL, reported_at_original TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL,
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('partner','human')), actor_user_id TEXT NOT NULL REFERENCES users(id),
 principal_id TEXT REFERENCES platform_principals(id), credential_id TEXT REFERENCES platform_credentials(id),
 delegation_id TEXT REFERENCES platform_delegations(id), membership_id TEXT REFERENCES platform_memberships(id), actor_context JSONB NOT NULL,
 receipt_canonical TEXT NOT NULL, receipt_sha256 TEXT NOT NULL CHECK(receipt_sha256 ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 FOREIGN KEY(connection_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 CHECK((actor_kind='partner' AND connection_id IS NOT NULL AND principal_id IS NOT NULL AND credential_id IS NOT NULL AND membership_id IS NULL) OR
       (actor_kind='human' AND principal_id IS NULL AND credential_id IS NULL AND delegation_id IS NULL AND membership_id IS NOT NULL))
);
CREATE UNIQUE INDEX record_source_artifact_identity ON record_source_artifacts(organization_id,environment,COALESCE(connection_id,''),source_artifact_id);
CREATE INDEX record_source_artifact_proof ON record_source_artifacts(proof_id,received_at,id);
CREATE TRIGGER record_source_artifact_immutable BEFORE UPDATE OR DELETE ON record_source_artifacts FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_upload_sessions (
 id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL UNIQUE REFERENCES record_source_artifacts(id),
 state TEXT NOT NULL CHECK(state IN ('open','receiving','received','complete','expired','rejected')),
 staging_key TEXT NOT NULL, staging_version_id TEXT, received_byte_size BIGINT, received_sha256 TEXT CHECK(received_sha256 ~ '^[a-f0-9]{64}$'),
 ingress_bytes BIGINT NOT NULL DEFAULT 0 CHECK(ingress_bytes>=0), ingress_limit_bytes BIGINT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT, lease_expires_at TIMESTAMPTZ, error_code TEXT
);
CREATE TABLE record_source_upload_parts (
 session_id TEXT NOT NULL REFERENCES record_source_upload_sessions(id), part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 48),
 object_key TEXT NOT NULL, object_version_id TEXT NOT NULL CHECK(object_version_id<>'null' AND object_version_id<>''),
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), byte_size BIGINT NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880), created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(session_id,part_number)
);
CREATE FUNCTION preserve_source_upload_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.artifact_id,NEW.staging_key,NEW.ingress_limit_bytes,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.artifact_id,OLD.staging_key,OLD.ingress_limit_bytes,OLD.expires_at,OLD.created_at)
 THEN RAISE EXCEPTION 'Source upload reservation is immutable'; END IF;
 IF OLD.staging_version_id IS NOT NULL AND ROW(NEW.staging_version_id,NEW.received_byte_size,NEW.received_sha256) IS DISTINCT FROM ROW(OLD.staging_version_id,OLD.received_byte_size,OLD.received_sha256)
 THEN RAISE EXCEPTION 'Received source original version is immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_source_upload_reservation_immutable BEFORE UPDATE OR DELETE ON record_source_upload_sessions FOR EACH ROW EXECUTE FUNCTION preserve_source_upload_session();
CREATE TRIGGER record_source_upload_part_immutable BEFORE UPDATE OR DELETE ON record_source_upload_parts FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_artifact_operations (
 id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL UNIQUE REFERENCES record_source_artifacts(id), session_id TEXT NOT NULL UNIQUE REFERENCES record_source_upload_sessions(id),
 staging_version_id TEXT NOT NULL CHECK(staging_version_id<>'null' AND staging_version_id<>''), candidate_canonical TEXT NOT NULL,
 candidate_sha256 TEXT NOT NULL CHECK(candidate_sha256 ~ '^[a-f0-9]{64}$'), received_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')), attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, lease_token TEXT, lease_expires_at TIMESTAMPTZ, error_code TEXT
);
CREATE INDEX record_source_artifact_work ON record_source_artifact_operations(state,next_attempt_at,lease_expires_at);
CREATE FUNCTION preserve_source_artifact_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.artifact_id,NEW.session_id,NEW.staging_version_id,NEW.candidate_canonical,NEW.candidate_sha256,NEW.received_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.artifact_id,OLD.session_id,OLD.staging_version_id,OLD.candidate_canonical,OLD.candidate_sha256,OLD.received_at)
 THEN RAISE EXCEPTION 'Source artifact completion candidates are immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_source_artifact_candidate_immutable BEFORE UPDATE OR DELETE ON record_source_artifact_operations FOR EACH ROW EXECUTE FUNCTION preserve_source_artifact_operation();
CREATE TABLE record_source_artifact_results (
 artifact_id TEXT PRIMARY KEY REFERENCES record_source_artifacts(id), operation_id TEXT NOT NULL UNIQUE REFERENCES record_source_artifact_operations(id),
 object_key TEXT NOT NULL, object_version_id TEXT NOT NULL CHECK(object_version_id<>'null' AND object_version_id<>''),
 staging_version_id TEXT NOT NULL CHECK(staging_version_id<>'null' AND staging_version_id<>''), sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_size BIGINT NOT NULL CHECK(byte_size BETWEEN 1 AND 250000000), content_type TEXT NOT NULL, accepted_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER record_source_artifact_result_immutable BEFORE UPDATE OR DELETE ON record_source_artifact_results FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_upload_budgets (
 organization_id TEXT NOT NULL, environment TEXT NOT NULL, reservation_day DATE NOT NULL, reserved_bytes BIGINT NOT NULL CHECK(reserved_bytes>=0),
 PRIMARY KEY(organization_id,environment,reservation_day), FOREIGN KEY(organization_id,environment) REFERENCES platform_organizations(id,environment)
);
