-- Additive operational reconstruction. Legacy Proofs, receipts, grants and
-- snapshot profiles are unchanged. No destructive down migration is supported.
CREATE TABLE record_cases (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 location_id TEXT NOT NULL, location_key TEXT NOT NULL, operator_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 root_namespace TEXT NOT NULL, root_type TEXT NOT NULL CHECK(root_type IN ('order','shipment','return')), root_external_id TEXT NOT NULL,
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id),
 CHECK(location_key=location_id), UNIQUE(id,organization_id,environment),
 UNIQUE(organization_id,environment,location_key,root_namespace,root_type,root_external_id)
);
CREATE TABLE record_typed_batches (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL, connection_id TEXT NOT NULL,
 location_id TEXT NOT NULL, subscription_id TEXT NOT NULL, configuration_revision BIGINT NOT NULL CHECK(configuration_revision>0), grant_revision BIGINT NOT NULL CHECK(grant_revision>0),
 principal_id TEXT NOT NULL REFERENCES platform_principals(id), credential_id TEXT NOT NULL REFERENCES platform_credentials(id),
 actor_context JSONB NOT NULL, operator_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 source_profile TEXT NOT NULL, source_namespace TEXT NOT NULL, mapping_version TEXT NOT NULL,
 preview_version TEXT NOT NULL, source_control_revision BIGINT NOT NULL CHECK(source_control_revision>=0),
 original_name TEXT NOT NULL, original_media_type TEXT NOT NULL,
 original_object_key TEXT NOT NULL, original_version_id TEXT NOT NULL,
 original_sha256 TEXT NOT NULL CHECK(original_sha256 ~ '^[a-f0-9]{64}$'), original_byte_size INTEGER NOT NULL CHECK(original_byte_size>0 AND original_byte_size<=2097152),
 contract JSONB NOT NULL, row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 1000),
 state TEXT NOT NULL CHECK(state IN ('previewed','queued','running','succeeded','partially_succeeded','blocked_policy','failed')),
 import_valid_rows BOOLEAN NOT NULL DEFAULT false, replay_requested BOOLEAN NOT NULL DEFAULT false, received_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT, lease_expires_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL, error_code TEXT,
 FOREIGN KEY(connection_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id), UNIQUE(id,organization_id,environment)
);
CREATE INDEX record_typed_batches_work ON record_typed_batches(state,next_attempt_at,received_at,id);
CREATE INDEX record_typed_batches_source ON record_typed_batches(subscription_id,configuration_revision,received_at,id);
CREATE TABLE record_typed_rows (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES record_typed_batches(id), row_number INTEGER NOT NULL CHECK(row_number>0),
 source_event_id TEXT, source_revision TEXT, payload_sha256 TEXT CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 source_values JSONB NOT NULL, normalized JSONB, errors JSONB NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('processing','accepted_linked','accepted_unlinked','duplicate','conflict','quarantined','rejected')),
 case_id TEXT REFERENCES record_cases(id), duplicate_of TEXT REFERENCES record_typed_rows(id), supersedes_id TEXT REFERENCES record_typed_rows(id),
 error_code TEXT, history_eligibility TEXT NOT NULL CHECK(history_eligibility IN ('within_bounds','unknown','out_of_bounds')), resolution_attempts INTEGER NOT NULL DEFAULT 0 CHECK(resolution_attempts>=0), received_at TIMESTAMPTZ NOT NULL, UNIQUE(batch_id,row_number)
);
CREATE INDEX record_typed_rows_case ON record_typed_rows(case_id,received_at,id);
CREATE INDEX record_typed_rows_pending ON record_typed_rows(status,resolution_attempts,received_at,id);
CREATE INDEX record_typed_rows_supersession ON record_typed_rows(supersedes_id);
CREATE TABLE record_typed_identities (
 organization_id TEXT NOT NULL, environment TEXT NOT NULL, connection_id TEXT NOT NULL, location_id TEXT NOT NULL,
 source_event_id TEXT NOT NULL, source_revision TEXT NOT NULL,
 row_id TEXT NOT NULL REFERENCES record_typed_rows(id), payload_sha256 TEXT NOT NULL,
 PRIMARY KEY(organization_id,environment,connection_id,location_id,source_event_id,source_revision),
 FOREIGN KEY(connection_id,organization_id,environment) REFERENCES platform_integration_accounts(id,merchant_id,environment),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id)
);
CREATE TRIGGER record_typed_identity_immutable BEFORE UPDATE OR DELETE ON record_typed_identities FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_case_entities (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 namespace TEXT NOT NULL, entity_type TEXT NOT NULL, external_id TEXT NOT NULL, parent_external_id TEXT NOT NULL DEFAULT '',
 receipt_id TEXT NOT NULL REFERENCES record_typed_rows(id), row_number INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 UNIQUE(case_id,namespace,entity_type,external_id,parent_external_id), UNIQUE(id,case_id)
);
CREATE INDEX record_case_entity_lookup ON record_case_entities(organization_id,environment,namespace,entity_type,external_id,case_id);
CREATE TABLE record_case_members (
 case_id TEXT NOT NULL, proof_id TEXT NOT NULL, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 source_row_id TEXT NOT NULL REFERENCES record_typed_rows(id), created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(case_id,proof_id,source_row_id),
 FOREIGN KEY(case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 FOREIGN KEY(proof_id,organization_id,environment) REFERENCES platform_proof_ownership(proof_id,merchant_id,environment)
);
CREATE TABLE record_case_assertions (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES record_cases(id), entity_id TEXT NOT NULL,
 batch_id TEXT NOT NULL REFERENCES record_typed_batches(id), row_number INTEGER NOT NULL,
 observation_id TEXT NOT NULL REFERENCES record_typed_rows(id), connection_id TEXT NOT NULL, source_namespace TEXT NOT NULL,
 property TEXT NOT NULL, value JSONB NOT NULL, unit TEXT, source_locator JSONB NOT NULL,
 mapping_version TEXT NOT NULL, source_revision TEXT NOT NULL,
 occurred_at TIMESTAMPTZ, source_as_of TIMESTAMPTZ, time_quality TEXT NOT NULL,
 origin JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(entity_id,case_id) REFERENCES record_case_entities(id,case_id)
);
CREATE INDEX record_case_assertion_case ON record_case_assertions(case_id,received_at,id);
CREATE INDEX record_case_assertion_observation ON record_case_assertions(observation_id);
CREATE TABLE record_case_relations (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES record_cases(id), from_entity_id TEXT NOT NULL,
 to_entity_id TEXT NOT NULL, relation_type TEXT NOT NULL, quantity JSONB,
 assertion_row_id TEXT NOT NULL REFERENCES record_typed_rows(id), created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(from_entity_id,case_id) REFERENCES record_case_entities(id,case_id),
 FOREIGN KEY(to_entity_id,case_id) REFERENCES record_case_entities(id,case_id)
);
CREATE INDEX record_case_relation_case ON record_case_relations(case_id,id);
CREATE TABLE record_case_crosswalks (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, environment TEXT NOT NULL, location_id TEXT NOT NULL,
 namespace TEXT NOT NULL, entity_type TEXT NOT NULL, external_id TEXT NOT NULL, parent_external_id TEXT NOT NULL DEFAULT '', case_id TEXT NOT NULL,
 rule_version TEXT NOT NULL, reason TEXT NOT NULL, approved_by TEXT NOT NULL REFERENCES users(id),
 supersedes_id TEXT REFERENCES record_case_crosswalks(id), created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id)
);
CREATE INDEX record_case_crosswalk_lookup ON record_case_crosswalks(organization_id,environment,location_id,namespace,entity_type,external_id,parent_external_id);
CREATE UNIQUE INDEX record_case_crosswalk_one_successor ON record_case_crosswalks(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TABLE record_case_outbox (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES record_cases(id), revision BIGINT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('case.updated','association.corrected')), observation_id TEXT REFERENCES record_typed_rows(id),
 created_at TIMESTAMPTZ NOT NULL, UNIQUE(case_id,revision)
);
CREATE TABLE record_case_association_decisions (
 id TEXT PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES record_typed_rows(id),
 case_id TEXT NOT NULL REFERENCES record_cases(id), supersedes_id TEXT REFERENCES record_case_association_decisions(id),
 basis JSONB NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX record_case_association_observation ON record_case_association_decisions(observation_id,created_at,id);
CREATE UNIQUE INDEX record_case_association_successor ON record_case_association_decisions(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TRIGGER record_case_association_immutable BEFORE UPDATE OR DELETE ON record_case_association_decisions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_assertion_immutable BEFORE UPDATE OR DELETE ON record_case_assertions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_relation_immutable BEFORE UPDATE OR DELETE ON record_case_relations FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_crosswalk_immutable BEFORE UPDATE OR DELETE ON record_case_crosswalks FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_outbox_immutable BEFORE UPDATE OR DELETE ON record_case_outbox FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION preserve_typed_batch_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Typed source originals are immutable'; END IF;
 IF ROW(NEW.id,NEW.organization_id,NEW.environment,NEW.connection_id,NEW.location_id,NEW.subscription_id,NEW.configuration_revision,NEW.grant_revision,NEW.principal_id,NEW.credential_id,NEW.actor_context,NEW.operator_membership_id,NEW.source_profile,NEW.source_namespace,NEW.mapping_version,NEW.preview_version,NEW.source_control_revision,NEW.original_name,NEW.original_media_type,NEW.original_object_key,NEW.original_version_id,NEW.original_sha256,NEW.original_byte_size,NEW.contract,NEW.row_count,NEW.received_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.environment,OLD.connection_id,OLD.location_id,OLD.subscription_id,OLD.configuration_revision,OLD.grant_revision,OLD.principal_id,OLD.credential_id,OLD.actor_context,OLD.operator_membership_id,OLD.source_profile,OLD.source_namespace,OLD.mapping_version,OLD.preview_version,OLD.source_control_revision,OLD.original_name,OLD.original_media_type,OLD.original_object_key,OLD.original_version_id,OLD.original_sha256,OLD.original_byte_size,OLD.contract,OLD.row_count,OLD.received_at)
 THEN RAISE EXCEPTION 'Typed source originals and authority are immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER record_typed_batch_origin BEFORE UPDATE OR DELETE ON record_typed_batches FOR EACH ROW EXECUTE FUNCTION preserve_typed_batch_origin();
CREATE FUNCTION preserve_typed_row_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Typed source rows are immutable'; END IF;
 IF ROW(NEW.id,NEW.batch_id,NEW.row_number,NEW.source_event_id,NEW.source_revision,NEW.payload_sha256,NEW.source_values,NEW.normalized,NEW.errors,NEW.history_eligibility,NEW.received_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.batch_id,OLD.row_number,OLD.source_event_id,OLD.source_revision,OLD.payload_sha256,OLD.source_values,OLD.normalized,OLD.errors,OLD.history_eligibility,OLD.received_at)
 THEN RAISE EXCEPTION 'Typed source row originals are immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER record_typed_row_origin BEFORE UPDATE OR DELETE ON record_typed_rows FOR EACH ROW EXECUTE FUNCTION preserve_typed_row_origin();

-- Composite ownership is checked at the database boundary as well as in
-- commands. A valid receipt ID alone never authorizes a different case/site.
CREATE FUNCTION record_operational_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='record_cases' THEN
  IF NOT EXISTS(SELECT 1 FROM platform_memberships m JOIN platform_organizations o ON o.id=m.organization_id WHERE m.id=NEW.operator_membership_id AND m.organization_id=NEW.organization_id AND o.environment=NEW.environment) THEN RAISE EXCEPTION 'Operational case operator scope does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_typed_batches' THEN
  IF NOT EXISTS(SELECT 1 FROM platform_memberships m JOIN platform_principals p ON p.organization_id=m.organization_id WHERE m.id=NEW.operator_membership_id AND m.organization_id=NEW.organization_id AND p.id=NEW.principal_id) THEN RAISE EXCEPTION 'Typed source principal and operator scope does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_typed_rows' THEN
  IF NEW.case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM record_typed_batches b JOIN record_cases c ON c.organization_id=b.organization_id AND c.environment=b.environment AND c.location_id=b.location_id AND c.operator_membership_id=b.operator_membership_id WHERE b.id=NEW.batch_id AND c.id=NEW.case_id) THEN RAISE EXCEPTION 'Typed row case scope does not match its original'; END IF;
 ELSIF TG_TABLE_NAME='record_typed_identities' THEN
  IF NOT EXISTS(SELECT 1 FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE r.id=NEW.row_id AND b.organization_id=NEW.organization_id AND b.environment=NEW.environment AND b.connection_id=NEW.connection_id AND b.location_id=NEW.location_id AND r.source_event_id=NEW.source_event_id AND r.source_revision=NEW.source_revision AND r.payload_sha256=NEW.payload_sha256) THEN RAISE EXCEPTION 'Typed identity scope does not match its original'; END IF;
 ELSIF TG_TABLE_NAME='record_case_entities' THEN
  IF NOT EXISTS(SELECT 1 FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id JOIN record_cases c ON c.organization_id=b.organization_id AND c.environment=b.environment AND c.location_id=b.location_id AND c.operator_membership_id=b.operator_membership_id WHERE r.id=NEW.receipt_id AND r.row_number=NEW.row_number AND c.id=NEW.case_id) THEN RAISE EXCEPTION 'Operational entity receipt scope does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_case_assertions' THEN
  IF NOT EXISTS(SELECT 1 FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id JOIN record_cases c ON c.organization_id=b.organization_id AND c.environment=b.environment AND c.location_id=b.location_id AND c.operator_membership_id=b.operator_membership_id WHERE r.id=NEW.observation_id AND r.row_number=NEW.row_number AND b.id=NEW.batch_id AND b.connection_id=NEW.connection_id AND b.source_namespace=NEW.source_namespace AND b.mapping_version=NEW.mapping_version AND r.source_revision=NEW.source_revision AND c.id=NEW.case_id) THEN RAISE EXCEPTION 'Operational assertion receipt scope does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_case_relations' OR TG_TABLE_NAME='record_case_association_decisions' THEN
  IF TG_TABLE_NAME='record_case_relations' THEN
   IF NOT EXISTS(SELECT 1 FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id JOIN record_cases c ON c.organization_id=b.organization_id AND c.environment=b.environment AND c.location_id=b.location_id AND c.operator_membership_id=b.operator_membership_id WHERE r.id=NEW.assertion_row_id AND c.id=NEW.case_id) THEN RAISE EXCEPTION 'Operational relationship receipt scope does not match'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id JOIN record_cases c ON c.organization_id=b.organization_id AND c.environment=b.environment AND c.location_id=b.location_id AND c.operator_membership_id=b.operator_membership_id WHERE r.id=NEW.observation_id AND c.id=NEW.case_id) THEN RAISE EXCEPTION 'Operational association scope does not match'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='record_case_crosswalks' THEN
  IF NOT EXISTS(SELECT 1 FROM record_cases c WHERE c.id=NEW.case_id AND c.organization_id=NEW.organization_id AND c.environment=NEW.environment AND c.location_id=NEW.location_id) THEN RAISE EXCEPTION 'Operational crosswalk site scope does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_case_members' THEN
  IF NOT EXISTS(SELECT 1 FROM record_cases c JOIN platform_proof_ownership o ON o.merchant_id=c.organization_id AND o.environment=c.environment AND o.operator_membership_id=c.operator_membership_id JOIN record_state s ON s.proof_id=o.proof_id AND s.location_id=c.location_id JOIN record_typed_rows r ON r.case_id=c.id AND r.id=NEW.source_row_id WHERE c.id=NEW.case_id AND o.proof_id=NEW.proof_id) THEN RAISE EXCEPTION 'Operational Proof member scope does not match'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER record_case_scope BEFORE INSERT OR UPDATE ON record_cases FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_typed_batch_scope BEFORE INSERT ON record_typed_batches FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_typed_row_scope BEFORE INSERT OR UPDATE ON record_typed_rows FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_typed_identity_scope BEFORE INSERT ON record_typed_identities FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_case_entity_scope BEFORE INSERT ON record_case_entities FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_case_assertion_scope BEFORE INSERT ON record_case_assertions FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_case_relation_scope BEFORE INSERT ON record_case_relations FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_case_decision_scope BEFORE INSERT ON record_case_association_decisions FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_case_crosswalk_scope BEFORE INSERT ON record_case_crosswalks FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
CREATE TRIGGER record_case_member_scope BEFORE INSERT ON record_case_members FOR EACH ROW EXECUTE FUNCTION record_operational_scope();
