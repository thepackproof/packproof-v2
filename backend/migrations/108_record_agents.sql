-- Narrow Windows collection grants. The existing credential/import tables remain authoritative.
CREATE TABLE record_agent_installations (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 principal_id TEXT NOT NULL UNIQUE REFERENCES platform_principals(id),
 credential_id TEXT NOT NULL UNIQUE REFERENCES platform_credentials(id),
 integration_account_id TEXT NOT NULL, operator_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 location_id TEXT, source_name TEXT NOT NULL,
 device_name TEXT NOT NULL, version TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'setup' CHECK(status IN ('setup','ready','active','paused','revoked')),
 config_revision INTEGER NOT NULL DEFAULT 0 CHECK(config_revision>=0),
 approved_config JSONB, config_sha256 TEXT, pending_proposal JSONB, pending_proposal_sha256 TEXT,
 test_import_id TEXT REFERENCES partner_import_jobs(id), verified_import_id TEXT REFERENCES partner_import_jobs(id),
 approval_user_id TEXT NOT NULL REFERENCES users(id),
 enrollment_expires_at TIMESTAMPTZ NOT NULL, enrollment_acknowledged_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ,
 heartbeat JSONB NOT NULL DEFAULT '{}',
 renewal_credential_id TEXT UNIQUE REFERENCES platform_credentials(id), renewal_response JSONB,
 renewal_expires_at TIMESTAMPTZ, renewal_key_hash TEXT,
 FOREIGN KEY(organization_id,environment) REFERENCES platform_organizations(id,environment),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id),
 FOREIGN KEY(integration_account_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 CHECK ((approved_config IS NULL AND config_sha256 IS NULL) OR (approved_config IS NOT NULL AND config_sha256 ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX record_agent_inventory ON record_agent_installations(organization_id,environment,id);
CREATE UNIQUE INDEX record_agent_one_active_source ON record_agent_installations(organization_id,environment,integration_account_id) WHERE status<>'revoked';
CREATE TABLE record_agent_enrollments (
 id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, comparison_code TEXT NOT NULL,
 device_name TEXT NOT NULL, device_hash TEXT NOT NULL, version TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','expired','acknowledged')),
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, last_poll_at TIMESTAMPTZ,
 installation_id TEXT UNIQUE REFERENCES record_agent_installations(id), credential_response JSONB
);
CREATE INDEX record_agent_pending ON record_agent_enrollments(device_hash,expires_at) WHERE state='pending';
-- Receipt snapshots bind every original to the approved configuration revision.
ALTER TABLE partner_import_jobs ADD COLUMN agent_installation_id TEXT REFERENCES record_agent_installations(id);
ALTER TABLE partner_import_jobs ADD COLUMN agent_config_revision INTEGER CHECK(agent_config_revision>0);
ALTER TABLE partner_import_jobs ADD CONSTRAINT partner_import_agent_revision CHECK((agent_installation_id IS NULL)=(agent_config_revision IS NULL));
CREATE FUNCTION preserve_partner_import_agent_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.agent_installation_id,NEW.agent_config_revision) IS DISTINCT FROM ROW(OLD.agent_installation_id,OLD.agent_config_revision) THEN RAISE EXCEPTION 'Accepted import configuration revision is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER partner_import_agent_revision_immutable BEFORE UPDATE ON partner_import_jobs FOR EACH ROW EXECUTE FUNCTION preserve_partner_import_agent_revision();
