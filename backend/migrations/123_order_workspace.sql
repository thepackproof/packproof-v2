-- Additive. Existing shipment receipts, source grants and proof identities remain valid.
CREATE TABLE record_order_sessions (
 id text PRIMARY KEY, installation_id text NOT NULL REFERENCES record_agent_installations(id),
 scope_digest text NOT NULL, scope jsonb NOT NULL, state text NOT NULL
 CHECK (state IN ('pending','active','denied','superseded')), created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, decided_at timestamptz, decided_by text REFERENCES users(id)
);
CREATE UNIQUE INDEX order_session_current ON record_order_sessions(installation_id) WHERE state='active';
CREATE UNIQUE INDEX order_session_pending ON record_order_sessions(installation_id) WHERE state='pending';
CREATE INDEX order_session_history ON record_order_sessions(installation_id,created_at DESC);
CREATE TABLE record_order_receipts (
 id text PRIMARY KEY, operation_key text NOT NULL, source_id text NOT NULL, generation integer NOT NULL,
 observation_id text NOT NULL, payload_digest text NOT NULL, original_sha256 text NOT NULL,
 object_key text NOT NULL, object_version text NOT NULL, file_name text NOT NULL, media_type text NOT NULL,
 profile_version text NOT NULL, issues jsonb NOT NULL, received_at timestamptz NOT NULL,
 session_id text REFERENCES record_order_sessions(id), UNIQUE(operation_key,source_id,generation,observation_id)
);
CREATE TABLE record_order_events (
 id text PRIMARY KEY, operation_key text NOT NULL, source_id text NOT NULL, event_id text NOT NULL,
 source_version text NOT NULL, receipt_id text NOT NULL REFERENCES record_order_receipts(id),
 payload_digest text NOT NULL, record jsonb NOT NULL, UNIQUE(operation_key,source_id,event_id,source_version)
);
CREATE TABLE record_order_event_refs (
 operation_key text NOT NULL, ref_key text NOT NULL, event_id text NOT NULL REFERENCES record_order_events(id),
 PRIMARY KEY(operation_key,ref_key,event_id)
);
CREATE INDEX order_event_receipt ON record_order_events(receipt_id);
CREATE TABLE record_order_roots (
 proof_id text PRIMARY KEY REFERENCES proofs(id), operation_key text NOT NULL, root_key text NOT NULL,
 source_id text NOT NULL, organization_id text NOT NULL REFERENCES platform_organizations(id),
 environment text NOT NULL, operator_membership_id text NOT NULL REFERENCES platform_memberships(id),
 location_id text, order_reference text NOT NULL,
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id),
 UNIQUE(operation_key,root_key)
);
CREATE INDEX order_roots_workspace ON record_order_roots(organization_id,environment,operator_membership_id,location_id);
CREATE TABLE record_order_revisions (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, proof_id text NOT NULL REFERENCES record_order_roots(proof_id),
 revision integer NOT NULL CHECK(revision>0), committed_at timestamptz NOT NULL, view jsonb NOT NULL, content_digest text NOT NULL,
 UNIQUE(proof_id,revision)
);
CREATE TABLE record_order_decisions (
 id text PRIMARY KEY, operation_key text NOT NULL, event_id text NOT NULL REFERENCES record_order_events(id),
 proof_id text REFERENCES record_order_roots(proof_id), reason text NOT NULL, actor_user_id text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL, supersedes_id text UNIQUE REFERENCES record_order_decisions(id)
);
CREATE TABLE record_order_link_state (
 event_id text PRIMARY KEY REFERENCES record_order_events(id), operation_key text NOT NULL,
 proof_ids text[] NOT NULL, unresolved boolean NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX order_pending_review ON record_order_link_state(operation_key,event_id) WHERE unresolved;
CREATE INDEX order_artifact_digest ON record_order_receipts(operation_key, source_id, original_sha256, received_at, id);
CREATE INDEX order_artifact_link ON record_order_events(operation_key, (record->'fields'->>'artifactSha256')) WHERE record->'fields' ? 'artifactSha256';
CREATE INDEX order_decision_event ON record_order_decisions(event_id,created_at DESC);
CREATE TRIGGER order_receipt_immutable BEFORE UPDATE OR DELETE ON record_order_receipts FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER order_event_immutable BEFORE UPDATE OR DELETE ON record_order_events FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER order_revision_immutable BEFORE UPDATE OR DELETE ON record_order_revisions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER order_decision_immutable BEFORE UPDATE OR DELETE ON record_order_decisions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();

-- The 0.5.0 service preserves the 0.4.x historical manifest and exact grant checks.
CREATE OR REPLACE FUNCTION record_source_backfill_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='record_source_backfill_jobs' THEN
  IF NOT EXISTS(SELECT 1 FROM record_source_subscriptions s JOIN record_source_subscription_revisions config ON config.subscription_id=s.id AND config.revision=s.configuration_revision JOIN record_agent_installations i ON i.id=s.installation_id JOIN platform_credentials c ON c.id=NEW.credential_id AND c.principal_id=s.principal_id WHERE s.id=NEW.subscription_id AND s.organization_id=NEW.organization_id AND s.environment=NEW.environment AND s.connection_id=NEW.connection_id AND s.location_id=NEW.location_id AND s.operator_membership_id=NEW.operator_membership_id AND s.principal_id=NEW.principal_id AND s.installation_id=NEW.installation_id AND s.configuration_revision=NEW.configuration_revision AND config.configuration_sha256=NEW.configuration_sha256 AND s.grant_revision=NEW.grant_revision AND s.state='active' AND i.version IN ('0.4.0','0.4.1','0.5.0') AND i.credential_id=NEW.credential_id AND i.enrollment_acknowledged_at IS NOT NULL AND i.status IN ('ready','active') AND NEW.actor_context->>'principalId'=NEW.principal_id AND NEW.actor_context->>'credentialId'=NEW.credential_id AND NEW.actor_context->>'merchantId'=NEW.organization_id AND NEW.actor_context->>'environment'=NEW.environment) THEN RAISE EXCEPTION 'Backfill job does not match its original current source authority'; END IF;
 ELSIF TG_TABLE_NAME='record_source_backfill_decisions' THEN
  IF NOT EXISTS(SELECT 1 FROM record_source_backfill_jobs j JOIN platform_memberships m ON m.id=NEW.actor_membership_id AND m.organization_id=j.organization_id JOIN users u ON u.id=m.user_id WHERE j.id=NEW.job_id AND j.manifest_sha256=NEW.manifest_sha256 AND m.user_id=NEW.actor_user_id AND m.role IN ('OWNER','ADMIN') AND m.revoked_at IS NULL AND u.status='ACTIVE' AND (m.location_scoped=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=m.id AND g.organization_id=m.organization_id AND g.location_id=j.location_id))) THEN RAISE EXCEPTION 'Backfill decision is outside current administrator scope'; END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM record_source_backfill_decisions predecessor_decision WHERE predecessor_decision.id=NEW.supersedes_id AND predecessor_decision.job_id=NEW.job_id) THEN RAISE EXCEPTION 'Backfill predecessor does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_source_backfill_receipts' THEN
  IF NOT EXISTS(SELECT 1 FROM record_source_backfill_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.manifest) item JOIN record_typed_batches b ON b.id=NEW.batch_id WHERE j.id=NEW.job_id AND item->>'id'=NEW.item_id AND b.organization_id=j.organization_id AND b.environment=j.environment AND b.subscription_id=j.subscription_id AND b.configuration_revision=j.configuration_revision AND b.grant_revision=j.grant_revision AND b.connection_id=j.connection_id AND b.location_id=j.location_id AND b.operator_membership_id=j.operator_membership_id AND b.principal_id=j.principal_id AND b.credential_id=j.credential_id AND b.original_name=item->>'name' AND b.original_sha256=item->>'sha256' AND b.original_media_type=item->>'mediaType' AND b.original_byte_size=(item->>'byteSize')::bigint) THEN RAISE EXCEPTION 'Backfill receipt does not match its original manifest and authority'; END IF;
 END IF;
 RETURN NEW;
END $$;

