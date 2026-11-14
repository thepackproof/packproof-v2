-- Independent additive profiles and privileged disposition workflow. Immutable
-- intake/assertion/association/Proof ledgers and old signed bytes are untouched.
CREATE TABLE record_reconstruction_signed_exports (
 id TEXT PRIMARY KEY, export_id TEXT NOT NULL REFERENCES record_reconstruction_exports(id),
 case_id TEXT NOT NULL, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 profile TEXT NOT NULL CHECK(profile='packproof.reconstruction-investigation/v2'),
 actor_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 binding_sha256 TEXT NOT NULL CHECK(binding_sha256 ~ '^[a-f0-9]{64}$'),
 manifest_canonical TEXT NOT NULL, manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 package_canonical TEXT NOT NULL, package_sha256 TEXT NOT NULL CHECK(package_sha256 ~ '^[a-f0-9]{64}$'),
 qualification TEXT NOT NULL CHECK(qualification IN ('qualified_runtime','synthetic_test_only')),
 created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 UNIQUE(export_id,profile,binding_sha256)
);
CREATE TRIGGER record_reconstruction_signed_export_immutable BEFORE UPDATE OR DELETE ON record_reconstruction_signed_exports FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION record_signed_export_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM record_reconstruction_exports e WHERE e.id=NEW.export_id AND e.case_id=NEW.case_id AND e.organization_id=NEW.organization_id AND e.environment=NEW.environment AND e.actor_membership_id=NEW.actor_membership_id) THEN RAISE EXCEPTION 'Signed export must retain its frozen export authority'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER record_reconstruction_signed_export_scope BEFORE INSERT ON record_reconstruction_signed_exports FOR EACH ROW EXECUTE FUNCTION record_signed_export_scope();

CREATE TABLE record_source_disposition_requests (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 impact_sha256 TEXT NOT NULL CHECK(impact_sha256 ~ '^[a-f0-9]{64}$'),
 policy_event_id TEXT NOT NULL REFERENCES record_typed_retention_events(id),
 target JSONB NOT NULL, requester JSONB NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(batch_id,organization_id,environment) REFERENCES record_typed_batches(id,organization_id,environment)
);
CREATE TRIGGER record_source_disposition_request_immutable BEFORE UPDATE OR DELETE ON record_source_disposition_requests FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION record_source_disposition_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM record_typed_batches b JOIN record_typed_retention_events e ON e.batch_id=b.id AND e.organization_id=b.organization_id AND e.environment=b.environment WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.environment=NEW.environment AND e.id=NEW.policy_event_id AND e.action='policy_assigned' AND NEW.target->>'batchId'=b.id AND NEW.target->>'organizationId'=b.organization_id AND NEW.target->>'environment'=b.environment AND NEW.target->>'key'=b.original_object_key AND NEW.target->>'versionId'=b.original_version_id AND NEW.target->>'sha256'=b.original_sha256 AND (NEW.target->>'byteSize')::INTEGER=b.original_byte_size AND NEW.target->>'policyVersion'=e.policy->>'version') THEN RAISE EXCEPTION 'Source disposition must match its immutable original and policy receipt'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER record_source_disposition_request_scope BEFORE INSERT ON record_source_disposition_requests FOR EACH ROW EXECUTE FUNCTION record_source_disposition_scope();
CREATE TABLE record_source_disposition_approvals (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES record_source_disposition_requests(id),
 impact_sha256 TEXT NOT NULL CHECK(impact_sha256 ~ '^[a-f0-9]{64}$'),
 approver JSONB NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER record_source_disposition_approval_immutable BEFORE UPDATE OR DELETE ON record_source_disposition_approvals FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_disposition_work (
 request_id TEXT PRIMARY KEY REFERENCES record_source_disposition_requests(id),
 state TEXT NOT NULL CHECK(state IN ('requested','approved','running','succeeded','blocked','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease_token TEXT, lease_expires_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ NOT NULL,
 error_code TEXT, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX record_source_disposition_pending ON record_source_disposition_work(state,next_attempt_at,request_id);
CREATE TABLE record_source_disposition_intents (
 request_id TEXT PRIMARY KEY REFERENCES record_source_disposition_requests(id),
 target_sha256 TEXT NOT NULL CHECK(target_sha256 ~ '^[a-f0-9]{64}$'),
 executor_binding_sha256 TEXT NOT NULL CHECK(executor_binding_sha256 ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER record_source_disposition_intent_immutable BEFORE UPDATE OR DELETE ON record_source_disposition_intents FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_disposition_results (
 request_id TEXT PRIMARY KEY REFERENCES record_source_disposition_requests(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('deleted_exact_version','already_absent')),
 target_sha256 TEXT NOT NULL CHECK(target_sha256 ~ '^[a-f0-9]{64}$'),
 executor_binding_sha256 TEXT NOT NULL CHECK(executor_binding_sha256 ~ '^[a-f0-9]{64}$'),
 execution_qualification TEXT NOT NULL CHECK(execution_qualification IN ('qualified_runtime','synthetic_test_only')),
 normalized_history_disposition TEXT NOT NULL CHECK(normalized_history_disposition='preserved_audit_history'),
 backup_erasure TEXT NOT NULL CHECK(backup_erasure='not_claimed'),
 created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER record_source_disposition_result_immutable BEFORE UPDATE OR DELETE ON record_source_disposition_results FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_compaction_commands (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES record_source_disposition_results(request_id),
 batch_id TEXT NOT NULL REFERENCES record_typed_batches(id), principal_id TEXT NOT NULL REFERENCES platform_principals(id),
 installation_id TEXT NOT NULL REFERENCES record_agent_installations(id),
 command JSONB NOT NULL, command_sha256 TEXT NOT NULL CHECK(command_sha256 ~ '^[a-f0-9]{64}$'),
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER record_source_compaction_command_immutable BEFORE UPDATE OR DELETE ON record_source_compaction_commands FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_compaction_permits (
 id TEXT PRIMARY KEY, command_id TEXT NOT NULL REFERENCES record_source_compaction_commands(id),
 actor_credential_id TEXT NOT NULL REFERENCES platform_credentials(id),
 command_sha256 TEXT NOT NULL CHECK(command_sha256 ~ '^[a-f0-9]{64}$'),
 issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+INTERVAL '30 seconds')
);
CREATE INDEX record_source_compaction_permits_command ON record_source_compaction_permits(command_id,expires_at);
CREATE TRIGGER record_source_compaction_permit_immutable BEFORE UPDATE OR DELETE ON record_source_compaction_permits FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_compaction_acknowledgements (
 command_id TEXT PRIMARY KEY REFERENCES record_source_compaction_commands(id),
 permit_id TEXT NOT NULL REFERENCES record_source_compaction_permits(id),
 actor_credential_id TEXT NOT NULL REFERENCES platform_credentials(id),
 acknowledgement JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER record_source_compaction_ack_immutable BEFORE UPDATE OR DELETE ON record_source_compaction_acknowledgements FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
