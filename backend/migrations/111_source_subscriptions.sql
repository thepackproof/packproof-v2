-- Approved source authority is separate from the existing CSV-only installation.
CREATE TABLE record_source_subscriptions (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES platform_organizations(id),
 environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 connection_id TEXT NOT NULL REFERENCES platform_integration_accounts(id),
 principal_id TEXT NOT NULL REFERENCES platform_principals(id),
 installation_id TEXT REFERENCES record_agent_installations(id),
 operator_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 location_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL DEFAULT 1 CHECK(configuration_revision>0),
 grant_revision INTEGER NOT NULL DEFAULT 1 CHECK(grant_revision>0),
 state TEXT NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','active','paused','revoked')),
 approved_by TEXT REFERENCES users(id),
 recurring_approved_by TEXT REFERENCES users(id),
 verified_batch_id TEXT,
 last_check_at TIMESTAMPTZ,
 source_as_of TIMESTAMPTZ,
 heartbeat JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(id,organization_id,environment),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id)
);
CREATE INDEX record_source_subscriptions_actor ON record_source_subscriptions(organization_id,environment,principal_id,state,id);
CREATE INDEX record_source_subscriptions_installation ON record_source_subscriptions(installation_id,state,id);
CREATE INDEX record_source_subscriptions_site ON record_source_subscriptions(organization_id,environment,location_id,operator_membership_id,id);
CREATE TABLE record_source_subscription_revisions (
 subscription_id TEXT NOT NULL REFERENCES record_source_subscriptions(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 configuration JSONB NOT NULL,
 configuration_sha256 TEXT NOT NULL CHECK(configuration_sha256 ~ '^[a-f0-9]{64}$'),
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(subscription_id,revision)
);
CREATE FUNCTION record_source_subscription_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Source subscription revisions are immutable'; END $$;
CREATE TRIGGER record_source_subscription_revision_immutable BEFORE UPDATE OR DELETE ON record_source_subscription_revisions FOR EACH ROW EXECUTE FUNCTION record_source_subscription_revision_immutable();
CREATE FUNCTION record_source_subscription_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform_organizations o JOIN platform_integration_accounts a ON a.merchant_id=o.id AND a.environment=o.environment JOIN platform_memberships m ON m.organization_id=o.id JOIN platform_principals p ON p.organization_id=o.id JOIN record_locations l ON l.organization_id=o.id WHERE o.id=NEW.organization_id AND o.environment=NEW.environment AND a.id=NEW.connection_id AND m.id=NEW.operator_membership_id AND p.id=NEW.principal_id AND l.id=NEW.location_id) THEN RAISE EXCEPTION 'Source subscription endpoints must share organization and environment'; END IF;
 IF NEW.installation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM record_agent_installations i WHERE i.id=NEW.installation_id AND i.principal_id=NEW.principal_id AND i.organization_id=NEW.organization_id AND i.environment=NEW.environment) THEN RAISE EXCEPTION 'Source subscription installation does not match its principal'; END IF;
 IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.environment,NEW.connection_id,NEW.principal_id,NEW.installation_id,NEW.operator_membership_id,NEW.location_id) IS DISTINCT FROM (OLD.organization_id,OLD.environment,OLD.connection_id,OLD.principal_id,OLD.installation_id,OLD.operator_membership_id,OLD.location_id) THEN RAISE EXCEPTION 'Source subscription authority is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_source_subscription_scope BEFORE INSERT OR UPDATE ON record_source_subscriptions FOR EACH ROW EXECUTE FUNCTION record_source_subscription_scope();
