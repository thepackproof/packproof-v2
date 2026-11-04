-- Durable CSV receipts and a resumable inbox. Source bytes live in the existing
-- private object store. A committed receipt is the worker's acceptance boundary.
CREATE TABLE record_import_jobs (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 created_by TEXT NOT NULL REFERENCES users(id),
 committed_by TEXT REFERENCES users(id),
 source_name TEXT NOT NULL,
 integration_account_id TEXT NOT NULL,
 preview_version TEXT NOT NULL,
 mapping_version TEXT NOT NULL,
 mapping JSONB NOT NULL,
 headers JSONB NOT NULL,
 delimiter TEXT NOT NULL,
 time_zone TEXT NOT NULL,
 original_object_key TEXT NOT NULL UNIQUE,
 original_version_id TEXT,
 original_sha256 TEXT NOT NULL CHECK(original_sha256 ~ '^[a-f0-9]{64}$'),
 original_byte_size INTEGER NOT NULL CHECK(original_byte_size BETWEEN 1 AND 2097152),
 state TEXT NOT NULL CHECK(state IN ('previewed','queued','running','succeeded','partially_succeeded','failed','action_needed')),
 import_valid_rows BOOLEAN NOT NULL DEFAULT false,
 received_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT,
 lease_expires_at TIMESTAMPTZ,
 last_error_code TEXT,
 FOREIGN KEY(organization_id,environment) REFERENCES platform_organizations(id,environment),
 FOREIGN KEY(integration_account_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment)
);
CREATE INDEX record_import_pending ON record_import_jobs(state,lease_expires_at,received_at);
CREATE INDEX record_import_scope ON record_import_jobs(organization_id,environment,received_at,id);
CREATE TABLE record_import_rows (
 import_id TEXT NOT NULL REFERENCES record_import_jobs(id),
 row_number INTEGER NOT NULL CHECK(row_number BETWEEN 2 AND 1001),
 status TEXT NOT NULL CHECK(status IN ('valid','invalid','duplicate','ambiguous','imported','failed')),
 source_values JSONB NOT NULL,
 normalized JSONB,
 payload_sha256 TEXT,
 errors JSONB NOT NULL,
 proof_id TEXT REFERENCES proofs(id),
 attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(import_id,row_number)
);
CREATE FUNCTION preserve_record_import_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Accepted import sources cannot be deleted through ordinary mutation'; END IF;
 IF TG_TABLE_NAME='record_import_rows' THEN
  IF ROW(NEW.import_id,NEW.row_number,NEW.source_values,NEW.normalized,NEW.payload_sha256)
   IS DISTINCT FROM ROW(OLD.import_id,OLD.row_number,OLD.source_values,OLD.normalized,OLD.payload_sha256)
   THEN RAISE EXCEPTION 'Import source rows are immutable; create a corrected preview'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.organization_id,NEW.environment,NEW.created_by,NEW.source_name,NEW.integration_account_id,NEW.preview_version,NEW.mapping_version,NEW.mapping,NEW.headers,NEW.delimiter,NEW.time_zone,NEW.original_object_key,NEW.original_version_id,NEW.original_sha256,NEW.original_byte_size,NEW.received_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.environment,OLD.created_by,OLD.source_name,OLD.integration_account_id,OLD.preview_version,OLD.mapping_version,OLD.mapping,OLD.headers,OLD.delimiter,OLD.time_zone,OLD.original_object_key,OLD.original_version_id,OLD.original_sha256,OLD.original_byte_size,OLD.received_at)
   THEN RAISE EXCEPTION 'Import receipt and source binding are immutable'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER record_import_source_immutable BEFORE UPDATE OR DELETE ON record_import_jobs FOR EACH ROW EXECUTE FUNCTION preserve_record_import_source();
CREATE TRIGGER record_import_rows_immutable BEFORE UPDATE OR DELETE ON record_import_rows FOR EACH ROW EXECUTE FUNCTION preserve_record_import_source();
