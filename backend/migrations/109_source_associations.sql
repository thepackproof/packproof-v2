-- Existing bindings cannot represent unlinked observations or approved child /
-- cross-system references. Keep canonical Proof and source-event stores intact.
ALTER TABLE partner_import_jobs ADD COLUMN source_control_revision BIGINT NOT NULL DEFAULT 0 CHECK(source_control_revision>=0);
CREATE FUNCTION preserve_partner_source_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_control_revision IS DISTINCT FROM OLD.source_control_revision THEN RAISE EXCEPTION 'Accepted source control revision is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER partner_import_source_control BEFORE UPDATE ON partner_import_jobs FOR EACH ROW EXECUTE FUNCTION preserve_partner_source_control();
CREATE TABLE record_source_crosswalks (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 connection_id TEXT NOT NULL, location_id TEXT,
 location_key TEXT NOT NULL, reference_type TEXT NOT NULL CHECK(reference_type IN ('SHIPMENT','ORDER','RETURN','package','pallet','item')),
 external_id TEXT NOT NULL, proof_id TEXT NOT NULL, rule_version TEXT NOT NULL,
 approved_by TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(connection_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id),
 CHECK(location_key=COALESCE(location_id,'')),
 UNIQUE(organization_id,environment,connection_id,location_key,reference_type,external_id)
);
CREATE TRIGGER record_source_crosswalk_immutable BEFORE UPDATE OR DELETE ON record_source_crosswalks FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_source_pending (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 connection_id TEXT NOT NULL, location_id TEXT, location_key TEXT NOT NULL,
 principal_id TEXT NOT NULL REFERENCES platform_principals(id), credential_id TEXT NOT NULL REFERENCES platform_credentials(id),
 actor_context JSONB NOT NULL, connection_revision BIGINT NOT NULL CHECK(connection_revision>=0), replay_revision BIGINT CHECK(replay_revision>=0), source_event_id TEXT NOT NULL, payload_canonical TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'), received_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','submitted','conflict','blocked_policy','retryable_error')),
 operation_id TEXT REFERENCES record_ingestion_operations(id), proof_id TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 error_code TEXT, resolution JSONB NOT NULL, normalized JSONB NOT NULL,
 FOREIGN KEY(connection_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id),
 CHECK(location_key=COALESCE(location_id,'')),
 UNIQUE(organization_id,environment,connection_id,location_key,source_event_id,payload_sha256)
);
CREATE INDEX record_source_pending_work ON record_source_pending(state,next_attempt_at,received_at);
CREATE INDEX record_source_pending_identity ON record_source_pending(organization_id,environment,connection_id,location_key,source_event_id);
CREATE TABLE record_source_resolution_attempts (
 id TEXT PRIMARY KEY, pending_id TEXT NOT NULL REFERENCES record_source_pending(id),
 outcome JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER record_source_resolution_immutable BEFORE UPDATE OR DELETE ON record_source_resolution_attempts FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION preserve_source_pending_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source association receipts are immutable'; END IF;
 IF ROW(NEW.id,NEW.organization_id,NEW.environment,NEW.connection_id,NEW.location_id,NEW.location_key,NEW.principal_id,NEW.credential_id,NEW.actor_context,NEW.connection_revision,NEW.source_event_id,NEW.payload_canonical,NEW.payload_sha256,NEW.received_at,NEW.normalized)
 IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.environment,OLD.connection_id,OLD.location_id,OLD.location_key,OLD.principal_id,OLD.credential_id,OLD.actor_context,OLD.connection_revision,OLD.source_event_id,OLD.payload_canonical,OLD.payload_sha256,OLD.received_at,OLD.normalized)
 THEN RAISE EXCEPTION 'Source association original and attribution are immutable'; END IF;
 IF OLD.operation_id IS NOT NULL AND ROW(NEW.operation_id,NEW.proof_id) IS DISTINCT FROM ROW(OLD.operation_id,OLD.proof_id)
 THEN RAISE EXCEPTION 'Submitted source association cannot be reassigned'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER record_source_pending_origin BEFORE UPDATE OR DELETE ON record_source_pending FOR EACH ROW EXECUTE FUNCTION preserve_source_pending_origin();
