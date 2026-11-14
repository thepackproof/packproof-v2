-- Separately approved finite historical collection. Business observations and
-- existing source grants remain unchanged; all job progress derives receipts.
CREATE TABLE record_source_backfill_jobs (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 connection_id TEXT NOT NULL,location_id TEXT NOT NULL,operator_membership_id TEXT NOT NULL,
 subscription_id TEXT NOT NULL REFERENCES record_source_subscriptions(id),configuration_revision BIGINT NOT NULL,
 configuration_sha256 TEXT NOT NULL,grant_revision BIGINT NOT NULL,principal_id TEXT NOT NULL,credential_id TEXT NOT NULL,
 installation_id TEXT NOT NULL REFERENCES record_agent_installations(id),actor_context JSONB NOT NULL,
 history_from TIMESTAMPTZ NOT NULL,history_to TIMESTAMPTZ NOT NULL,
 semantics TEXT NOT NULL CHECK(semantics IN ('cumulative_snapshot','event_delta')),
 manifest JSONB NOT NULL CHECK(jsonb_typeof(manifest)='array' AND jsonb_array_length(manifest) BETWEEN 1 AND 100),
 manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),created_at TIMESTAMPTZ NOT NULL,
 CHECK(history_to>=history_from),
 FOREIGN KEY(subscription_id,configuration_revision) REFERENCES record_source_subscription_revisions(subscription_id,revision),
 FOREIGN KEY(operator_membership_id,organization_id) REFERENCES platform_memberships(id,organization_id),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id)
);
CREATE INDEX record_source_backfill_source ON record_source_backfill_jobs(subscription_id,created_at,id);
CREATE TABLE record_source_backfill_decisions (
 id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES record_source_backfill_jobs(id),
 action TEXT NOT NULL CHECK(action IN ('approve','pause','resume')),whole_file_consent BOOLEAN NOT NULL,
 expires_at TIMESTAMPTZ,reason TEXT NOT NULL,actor_user_id TEXT NOT NULL REFERENCES users(id),
 actor_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),manifest_sha256 TEXT NOT NULL,
 supersedes_id TEXT REFERENCES record_source_backfill_decisions(id),created_at TIMESTAMPTZ NOT NULL,
 CHECK(action='pause' OR (whole_file_consent=true AND expires_at>created_at AND expires_at<=created_at+INTERVAL '24 hours'))
);
CREATE INDEX record_source_backfill_decision_job ON record_source_backfill_decisions(job_id,created_at,id);
CREATE UNIQUE INDEX record_source_backfill_decision_first ON record_source_backfill_decisions(job_id) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX record_source_backfill_decision_successor ON record_source_backfill_decisions(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TABLE record_source_backfill_receipts (
 job_id TEXT NOT NULL REFERENCES record_source_backfill_jobs(id),item_id TEXT NOT NULL,
 batch_id TEXT NOT NULL REFERENCES record_typed_batches(id),created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(job_id,item_id),UNIQUE(job_id,batch_id)
);
CREATE INDEX record_source_backfill_receipt_batch ON record_source_backfill_receipts(batch_id);
CREATE TRIGGER record_source_backfill_job_immutable BEFORE UPDATE OR DELETE ON record_source_backfill_jobs FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_source_backfill_decision_immutable BEFORE UPDATE OR DELETE ON record_source_backfill_decisions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_source_backfill_receipt_immutable BEFORE UPDATE OR DELETE ON record_source_backfill_receipts FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION record_source_backfill_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='record_source_backfill_jobs' THEN
  IF NOT EXISTS(SELECT 1 FROM record_source_subscriptions s JOIN record_source_subscription_revisions config ON config.subscription_id=s.id AND config.revision=s.configuration_revision JOIN record_agent_installations i ON i.id=s.installation_id JOIN platform_credentials c ON c.id=NEW.credential_id AND c.principal_id=s.principal_id WHERE s.id=NEW.subscription_id AND s.organization_id=NEW.organization_id AND s.environment=NEW.environment AND s.connection_id=NEW.connection_id AND s.location_id=NEW.location_id AND s.operator_membership_id=NEW.operator_membership_id AND s.principal_id=NEW.principal_id AND s.installation_id=NEW.installation_id AND s.configuration_revision=NEW.configuration_revision AND config.configuration_sha256=NEW.configuration_sha256 AND s.grant_revision=NEW.grant_revision AND s.state='active' AND i.version='0.4.0' AND i.credential_id=NEW.credential_id AND i.enrollment_acknowledged_at IS NOT NULL AND i.status IN ('ready','active') AND NEW.actor_context->>'principalId'=NEW.principal_id AND NEW.actor_context->>'credentialId'=NEW.credential_id AND NEW.actor_context->>'merchantId'=NEW.organization_id AND NEW.actor_context->>'environment'=NEW.environment) THEN RAISE EXCEPTION 'Backfill job does not match its original current source authority'; END IF;
 ELSIF TG_TABLE_NAME='record_source_backfill_decisions' THEN
  IF NOT EXISTS(SELECT 1 FROM record_source_backfill_jobs j JOIN platform_memberships m ON m.id=NEW.actor_membership_id AND m.organization_id=j.organization_id JOIN users u ON u.id=m.user_id WHERE j.id=NEW.job_id AND j.manifest_sha256=NEW.manifest_sha256 AND m.user_id=NEW.actor_user_id AND m.role IN ('OWNER','ADMIN') AND m.revoked_at IS NULL AND u.status='ACTIVE' AND (m.location_scoped=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=m.id AND g.organization_id=m.organization_id AND g.location_id=j.location_id))) THEN RAISE EXCEPTION 'Backfill decision is outside current administrator scope'; END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM record_source_backfill_decisions predecessor_decision WHERE predecessor_decision.id=NEW.supersedes_id AND predecessor_decision.job_id=NEW.job_id) THEN RAISE EXCEPTION 'Backfill predecessor does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_source_backfill_receipts' THEN
  IF NOT EXISTS(SELECT 1 FROM record_source_backfill_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.manifest) item JOIN record_typed_batches b ON b.id=NEW.batch_id WHERE j.id=NEW.job_id AND item->>'id'=NEW.item_id AND b.organization_id=j.organization_id AND b.environment=j.environment AND b.subscription_id=j.subscription_id AND b.configuration_revision=j.configuration_revision AND b.grant_revision=j.grant_revision AND b.connection_id=j.connection_id AND b.location_id=j.location_id AND b.operator_membership_id=j.operator_membership_id AND b.principal_id=j.principal_id AND b.credential_id=j.credential_id AND b.original_name=item->>'name' AND b.original_sha256=item->>'sha256' AND b.original_media_type=item->>'mediaType' AND b.original_byte_size=(item->>'byteSize')::bigint) THEN RAISE EXCEPTION 'Backfill receipt does not match its original manifest and authority'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_source_backfill_job_scope BEFORE INSERT ON record_source_backfill_jobs FOR EACH ROW EXECUTE FUNCTION record_source_backfill_scope();
CREATE TRIGGER record_source_backfill_decision_scope BEFORE INSERT ON record_source_backfill_decisions FOR EACH ROW EXECUTE FUNCTION record_source_backfill_scope();
CREATE TRIGGER record_source_backfill_receipt_scope BEFORE INSERT ON record_source_backfill_receipts FOR EACH ROW EXECUTE FUNCTION record_source_backfill_scope();
