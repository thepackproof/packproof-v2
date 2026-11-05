-- Service imports retain actual credential authority and never create a human session.
CREATE TABLE partner_import_jobs (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 actor JSONB NOT NULL, principal_id TEXT NOT NULL, credential_id TEXT NOT NULL, delegation_id TEXT,
 integration_account_id TEXT NOT NULL, operator_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 source_name TEXT NOT NULL, preview_version TEXT NOT NULL, mapping_version TEXT NOT NULL, mapping JSONB NOT NULL,
 headers JSONB NOT NULL, delimiter TEXT NOT NULL, time_zone TEXT NOT NULL,
 original_object_key TEXT NOT NULL UNIQUE, original_version_id TEXT NOT NULL, original_sha256 TEXT NOT NULL CHECK(original_sha256 ~ '^[a-f0-9]{64}$'),
 original_byte_size INTEGER NOT NULL CHECK(original_byte_size BETWEEN 1 AND 2097152),
 state TEXT NOT NULL CHECK(state IN ('previewed','queued','running','succeeded','partially_succeeded','failed','action_needed')),
 import_valid_rows BOOLEAN NOT NULL DEFAULT false, received_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT, lease_expires_at TIMESTAMPTZ, last_error_code TEXT,
 FOREIGN KEY(organization_id,environment) REFERENCES platform_organizations(id,environment),
 FOREIGN KEY(integration_account_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment)
);
CREATE INDEX partner_import_pending ON partner_import_jobs(state,lease_expires_at,received_at,id);
CREATE INDEX partner_import_scope ON partner_import_jobs(organization_id,environment,principal_id,received_at,id);
CREATE TABLE partner_import_rows (
 import_id TEXT NOT NULL REFERENCES partner_import_jobs(id), row_number INTEGER NOT NULL CHECK(row_number BETWEEN 2 AND 1001),
 status TEXT NOT NULL CHECK(status IN ('valid','invalid','duplicate','ambiguous','imported','failed')),
 source_values JSONB NOT NULL, normalized JSONB, payload_sha256 TEXT, errors JSONB NOT NULL,
 proof_id TEXT REFERENCES proofs(id), attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(import_id,row_number)
);
CREATE FUNCTION preserve_partner_import_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Accepted service import sources are immutable'; END IF;
 IF TG_TABLE_NAME='partner_import_rows' THEN
  IF ROW(NEW.import_id,NEW.row_number,NEW.source_values,NEW.normalized,NEW.payload_sha256) IS DISTINCT FROM ROW(OLD.import_id,OLD.row_number,OLD.source_values,OLD.normalized,OLD.payload_sha256) THEN RAISE EXCEPTION 'Create a corrected preview'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.organization_id,NEW.environment,NEW.actor,NEW.principal_id,NEW.credential_id,NEW.delegation_id,NEW.integration_account_id,NEW.operator_membership_id,NEW.source_name,NEW.preview_version,NEW.mapping_version,NEW.mapping,NEW.headers,NEW.delimiter,NEW.time_zone,NEW.original_object_key,NEW.original_version_id,NEW.original_sha256,NEW.original_byte_size,NEW.received_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.environment,OLD.actor,OLD.principal_id,OLD.credential_id,OLD.delegation_id,OLD.integration_account_id,OLD.operator_membership_id,OLD.source_name,OLD.preview_version,OLD.mapping_version,OLD.mapping,OLD.headers,OLD.delimiter,OLD.time_zone,OLD.original_object_key,OLD.original_version_id,OLD.original_sha256,OLD.original_byte_size,OLD.received_at) THEN RAISE EXCEPTION 'Service import authority and source binding are immutable'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER partner_import_source_immutable BEFORE UPDATE OR DELETE ON partner_import_jobs FOR EACH ROW EXECUTE FUNCTION preserve_partner_import_source();
CREATE TRIGGER partner_import_rows_immutable BEFORE UPDATE OR DELETE ON partner_import_rows FOR EACH ROW EXECUTE FUNCTION preserve_partner_import_source();

-- Fixed canonical selections; this does not confer operational signing authority.
CREATE TABLE record_canonical_export_jobs (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('PARTNER','HUMAN')), actor JSONB NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id),
 principal_id TEXT, credential_id TEXT, delegation_id TEXT, membership_id TEXT,
 proof_id TEXT NOT NULL REFERENCES proofs(id), selection JSONB NOT NULL, selection_sha256 TEXT NOT NULL CHECK(selection_sha256 ~ '^[a-f0-9]{64}$'),
 state TEXT NOT NULL CHECK(state IN ('queued','running','ready','action_needed','expired')),
 received_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 artifact_time TIMESTAMPTZ NOT NULL, ready_at TIMESTAMPTZ, object_key TEXT, object_version_id TEXT, artifact_sha256 TEXT, artifact_byte_size BIGINT,
 lease_token TEXT, lease_expires_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
 FOREIGN KEY(organization_id,environment) REFERENCES platform_organizations(id,environment),
 CHECK((owner_kind='PARTNER' AND principal_id IS NOT NULL AND credential_id IS NOT NULL AND membership_id IS NULL) OR (owner_kind='HUMAN' AND principal_id IS NULL AND credential_id IS NULL AND membership_id IS NOT NULL)),
 CHECK(state<>'ready' OR (object_key IS NOT NULL AND object_version_id IS NOT NULL AND artifact_sha256 ~ '^[a-f0-9]{64}$' AND artifact_byte_size>0 AND ready_at IS NOT NULL))
);
CREATE INDEX canonical_exports_pending ON record_canonical_export_jobs(state,lease_expires_at,received_at,id);
CREATE INDEX canonical_exports_scope ON record_canonical_export_jobs(organization_id,environment,received_at,id);
CREATE FUNCTION preserve_canonical_export_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Accepted export receipts are immutable'; END IF;
 IF ROW(NEW.id,NEW.organization_id,NEW.environment,NEW.owner_kind,NEW.actor,NEW.actor_user_id,NEW.principal_id,NEW.credential_id,NEW.delegation_id,NEW.membership_id,NEW.proof_id,NEW.selection,NEW.selection_sha256,NEW.received_at,NEW.expires_at,NEW.artifact_time)
  IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.environment,OLD.owner_kind,OLD.actor,OLD.actor_user_id,OLD.principal_id,OLD.credential_id,OLD.delegation_id,OLD.membership_id,OLD.proof_id,OLD.selection,OLD.selection_sha256,OLD.received_at,OLD.expires_at,OLD.artifact_time) THEN RAISE EXCEPTION 'Export selection and authority are immutable'; END IF;
 IF OLD.ready_at IS NOT NULL AND ROW(NEW.ready_at,NEW.object_key,NEW.object_version_id,NEW.artifact_sha256,NEW.artifact_byte_size) IS DISTINCT FROM ROW(OLD.ready_at,OLD.object_key,OLD.object_version_id,OLD.artifact_sha256,OLD.artifact_byte_size) THEN RAISE EXCEPTION 'Completed export artifact is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER canonical_export_selection_immutable BEFORE UPDATE OR DELETE ON record_canonical_export_jobs FOR EACH ROW EXECUTE FUNCTION preserve_canonical_export_selection();
