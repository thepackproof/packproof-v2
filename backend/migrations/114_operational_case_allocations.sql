-- Per-case interpretation of one preserved source row. A shared pallet/load
-- never makes its unrelated orders one case or grants access to its neighbors.
CREATE TABLE record_case_row_projections (
 id TEXT PRIMARY KEY,observation_id TEXT NOT NULL REFERENCES record_typed_rows(id),
 case_id TEXT NOT NULL,organization_id TEXT NOT NULL,environment TEXT NOT NULL,
 location_id TEXT NOT NULL,operator_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 state TEXT NOT NULL CHECK(state IN ('linked','removed')),
 normalized JSONB NOT NULL,assertion_indexes JSONB NOT NULL,relationship_indexes JSONB NOT NULL,
 assertion_ids JSONB NOT NULL,relationship_ids JSONB NOT NULL,
 basis JSONB NOT NULL,supersedes_id TEXT REFERENCES record_case_row_projections(id),created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment)
);
CREATE INDEX record_case_row_projection_lookup ON record_case_row_projections(observation_id,case_id,created_at,id);
CREATE INDEX record_case_row_projection_case ON record_case_row_projections(case_id,observation_id);
CREATE UNIQUE INDEX record_case_row_projection_successor ON record_case_row_projections(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TABLE record_case_links (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,environment TEXT NOT NULL,location_id TEXT NOT NULL,
 left_case_id TEXT NOT NULL,right_case_id TEXT NOT NULL,shared_reference JSONB NOT NULL,
 observation_id TEXT NOT NULL REFERENCES record_typed_rows(id),
 relation_type TEXT NOT NULL CHECK(relation_type IN ('shared_handling_unit','shared_load','shared_stop')),
 state TEXT NOT NULL CHECK(state IN ('linked','removed')),basis JSONB NOT NULL,
 supersedes_id TEXT REFERENCES record_case_links(id),created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(left_case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 FOREIGN KEY(right_case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 CHECK(left_case_id<right_case_id)
);
CREATE INDEX record_case_links_left ON record_case_links(left_case_id,created_at,id);
CREATE INDEX record_case_links_right ON record_case_links(right_case_id,created_at,id);
CREATE INDEX record_case_links_observation ON record_case_links(observation_id);
CREATE UNIQUE INDEX record_case_links_successor ON record_case_links(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TABLE record_case_entity_aliases (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,environment TEXT NOT NULL,location_id TEXT NOT NULL,
 left_case_id TEXT NOT NULL,right_case_id TEXT NOT NULL,left_reference JSONB NOT NULL,right_reference JSONB NOT NULL,
 cardinality TEXT NOT NULL CHECK(cardinality='one_to_one'),effective_from TIMESTAMPTZ,effective_until TIMESTAMPTZ,
 rule_version TEXT NOT NULL,reason TEXT NOT NULL,approved_by TEXT NOT NULL REFERENCES users(id),
 supersedes_id TEXT REFERENCES record_case_entity_aliases(id),created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(left_case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 FOREIGN KEY(right_case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 CHECK(effective_until IS NULL OR effective_from IS NULL OR effective_until>effective_from)
);
CREATE INDEX record_case_entity_alias_left ON record_case_entity_aliases(organization_id,environment,location_id,left_case_id);
CREATE INDEX record_case_entity_alias_right ON record_case_entity_aliases(organization_id,environment,location_id,right_case_id);
CREATE UNIQUE INDEX record_case_entity_alias_successor ON record_case_entity_aliases(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TABLE record_case_identity_rules (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,environment TEXT NOT NULL,location_id TEXT NOT NULL,
 left_namespace TEXT NOT NULL,right_namespace TEXT NOT NULL,entity_type TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode='exact_external_and_parent'),cardinality TEXT NOT NULL CHECK(cardinality='one_to_one'),
 effective_from TIMESTAMPTZ,effective_until TIMESTAMPTZ,rule_version TEXT NOT NULL,reason TEXT NOT NULL,
 approved_by TEXT NOT NULL REFERENCES users(id),supersedes_id TEXT REFERENCES record_case_identity_rules(id),created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(location_id,organization_id) REFERENCES record_locations(id,organization_id),
 CHECK(left_namespace<right_namespace),CHECK(effective_until IS NULL OR effective_from IS NULL OR effective_until>effective_from)
);
CREATE INDEX record_case_identity_rule_lookup ON record_case_identity_rules(organization_id,environment,location_id,entity_type,left_namespace,right_namespace);
CREATE UNIQUE INDEX record_case_identity_rule_successor ON record_case_identity_rules(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TRIGGER record_case_row_projection_immutable BEFORE UPDATE OR DELETE ON record_case_row_projections FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_link_immutable BEFORE UPDATE OR DELETE ON record_case_links FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_entity_alias_immutable BEFORE UPDATE OR DELETE ON record_case_entity_aliases FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_identity_rule_immutable BEFORE UPDATE OR DELETE ON record_case_identity_rules FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION record_case_partition_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='record_case_row_projections' THEN
  IF NOT EXISTS(SELECT 1 FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id JOIN record_cases c ON c.id=NEW.case_id WHERE r.id=NEW.observation_id AND b.organization_id=NEW.organization_id AND b.environment=NEW.environment AND b.location_id=NEW.location_id AND b.operator_membership_id=NEW.operator_membership_id AND c.organization_id=b.organization_id AND c.environment=b.environment AND c.location_id=b.location_id AND c.operator_membership_id=b.operator_membership_id) THEN RAISE EXCEPTION 'Case partition scope does not match its original'; END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM record_case_row_projections prior WHERE prior.id=NEW.supersedes_id AND prior.observation_id=NEW.observation_id AND prior.case_id=NEW.case_id) THEN RAISE EXCEPTION 'Case partition predecessor scope does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_case_links' THEN
  IF NOT EXISTS(SELECT 1 FROM record_cases l JOIN record_cases r ON r.organization_id=l.organization_id AND r.environment=l.environment AND r.location_id=l.location_id JOIN record_typed_rows source ON source.id=NEW.observation_id JOIN record_typed_batches b ON b.id=source.batch_id WHERE l.id=NEW.left_case_id AND r.id=NEW.right_case_id AND l.organization_id=NEW.organization_id AND l.environment=NEW.environment AND l.location_id=NEW.location_id AND b.organization_id=l.organization_id AND b.environment=l.environment AND b.location_id=l.location_id AND b.operator_membership_id=l.operator_membership_id AND b.operator_membership_id=r.operator_membership_id) THEN RAISE EXCEPTION 'Cross-case relationship endpoints do not match their original authority'; END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM record_case_links prior WHERE prior.id=NEW.supersedes_id AND prior.observation_id=NEW.observation_id AND prior.left_case_id=NEW.left_case_id AND prior.right_case_id=NEW.right_case_id AND prior.shared_reference=NEW.shared_reference) THEN RAISE EXCEPTION 'Cross-case relationship predecessor scope does not match'; END IF;
 ELSIF TG_TABLE_NAME='record_case_entity_aliases' THEN
  IF NOT EXISTS(SELECT 1 FROM record_cases l JOIN record_cases r ON r.organization_id=l.organization_id AND r.environment=l.environment AND r.location_id=l.location_id WHERE l.id=NEW.left_case_id AND r.id=NEW.right_case_id AND l.organization_id=NEW.organization_id AND l.environment=NEW.environment AND l.location_id=NEW.location_id) THEN RAISE EXCEPTION 'Entity alias endpoint scope does not match'; END IF;
  IF NEW.left_reference->>'type' IS DISTINCT FROM NEW.right_reference->>'type' THEN RAISE EXCEPTION 'Entity aliases must preserve entity type'; END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM record_case_entity_aliases prior WHERE prior.id=NEW.supersedes_id AND prior.organization_id=NEW.organization_id AND prior.environment=NEW.environment AND prior.location_id=NEW.location_id) THEN RAISE EXCEPTION 'Entity alias predecessor scope does not match'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_case_projection_scope BEFORE INSERT ON record_case_row_projections FOR EACH ROW EXECUTE FUNCTION record_case_partition_scope();
CREATE TRIGGER record_case_link_scope BEFORE INSERT ON record_case_links FOR EACH ROW EXECUTE FUNCTION record_case_partition_scope();
CREATE TRIGGER record_case_entity_alias_scope BEFORE INSERT ON record_case_entity_aliases FOR EACH ROW EXECUTE FUNCTION record_case_partition_scope();
-- A Proof member remains an append-only source association, but one source row
-- can now have several independently governed case projections.
DROP TRIGGER record_case_member_scope ON record_case_members;
CREATE FUNCTION record_case_member_scope_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM record_cases c JOIN platform_proof_ownership o ON o.merchant_id=c.organization_id AND o.environment=c.environment AND o.operator_membership_id=c.operator_membership_id JOIN record_state s ON s.proof_id=o.proof_id AND s.location_id=c.location_id JOIN record_typed_rows r ON r.id=NEW.source_row_id WHERE c.id=NEW.case_id AND o.proof_id=NEW.proof_id AND ((r.case_id=c.id AND r.status='accepted_linked' AND NOT EXISTS(SELECT 1 FROM record_case_row_projections any_projection WHERE any_projection.observation_id=r.id)) OR EXISTS(SELECT 1 FROM record_case_row_projections p WHERE p.observation_id=r.id AND p.case_id=c.id AND p.state='linked' AND NOT EXISTS(SELECT 1 FROM record_case_row_projections successor WHERE successor.supersedes_id=p.id)))) THEN RAISE EXCEPTION 'Operational Proof member scope does not match'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_case_member_scope BEFORE INSERT ON record_case_members FOR EACH ROW EXECUTE FUNCTION record_case_member_scope_v2();
-- Source-authorized cumulative snapshots use source business time, never arrival
-- time, to select the active observation. This records the interpretation basis
-- without inventing a correction in the preserved source normalized payload.
CREATE TABLE record_typed_snapshot_versions (
 observation_id TEXT PRIMARY KEY REFERENCES record_typed_rows(id),
 organization_id TEXT NOT NULL,environment TEXT NOT NULL,connection_id TEXT NOT NULL,location_id TEXT NOT NULL,
 subscription_id TEXT NOT NULL REFERENCES record_source_subscriptions(id),source_namespace TEXT NOT NULL,source_event_id TEXT NOT NULL,source_as_of TIMESTAMPTZ NOT NULL,
 policy_version TEXT NOT NULL,policy_sha256 TEXT NOT NULL,basis TEXT NOT NULL CHECK(basis='approved_snapshot_policy'),
 created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(organization_id,environment,connection_id,location_id,subscription_id,source_namespace,source_event_id,source_as_of)
);
CREATE INDEX record_typed_snapshot_active ON record_typed_snapshot_versions(organization_id,environment,connection_id,location_id,subscription_id,source_namespace,source_event_id,source_as_of DESC);
CREATE TRIGGER record_typed_snapshot_immutable BEFORE UPDATE OR DELETE ON record_typed_snapshot_versions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION record_typed_snapshot_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id JOIN record_source_subscription_revisions config ON config.subscription_id=b.subscription_id AND config.revision=b.configuration_revision WHERE r.id=NEW.observation_id AND b.organization_id=NEW.organization_id AND b.environment=NEW.environment AND b.connection_id=NEW.connection_id AND b.location_id=NEW.location_id AND b.subscription_id=NEW.subscription_id AND b.source_namespace=NEW.source_namespace AND r.source_event_id=NEW.source_event_id AND r.normalized->>'observationKind' IN ('snapshot','correction','tombstone') AND (r.normalized->>'sourceAsOf')::timestamptz=NEW.source_as_of AND b.contract->>'schema'='packproof.typed-source-batch/v2' AND b.contract->'identityPolicy'->'revision'->>'kind'='source_as_of' AND config.configuration->'identityPolicy'=b.contract->'identityPolicy' AND config.configuration->'identityPolicy'->>'schema'=NEW.policy_version) THEN RAISE EXCEPTION 'Snapshot version does not match its preserved approved source policy'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_typed_snapshot_scope BEFORE INSERT ON record_typed_snapshot_versions FOR EACH ROW EXECUTE FUNCTION record_typed_snapshot_scope();
CREATE UNIQUE INDEX record_case_row_projection_first ON record_case_row_projections(observation_id,case_id) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX record_case_links_first ON record_case_links(observation_id,left_case_id,right_case_id,shared_reference) WHERE supersedes_id IS NULL;

-- Version two source identity is a stream-local business key. Sources on one
-- installation connection cannot deduplicate or supersede each other's rows.
CREATE TABLE record_typed_source_identities_v2 (
 organization_id TEXT NOT NULL,environment TEXT NOT NULL,connection_id TEXT NOT NULL,location_id TEXT NOT NULL,
 subscription_id TEXT NOT NULL REFERENCES record_source_subscriptions(id),source_namespace TEXT NOT NULL,
 source_event_id TEXT NOT NULL,source_revision TEXT NOT NULL,row_id TEXT NOT NULL REFERENCES record_typed_rows(id),payload_sha256 TEXT NOT NULL,
 PRIMARY KEY(organization_id,environment,connection_id,location_id,subscription_id,source_namespace,source_event_id,source_revision),
 UNIQUE(row_id)
);
CREATE TRIGGER record_typed_source_identity_v2_immutable BEFORE UPDATE OR DELETE ON record_typed_source_identities_v2 FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE FUNCTION record_typed_source_identity_v2_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE r.id=NEW.row_id AND b.organization_id=NEW.organization_id AND b.environment=NEW.environment AND b.connection_id=NEW.connection_id AND b.location_id=NEW.location_id AND b.subscription_id=NEW.subscription_id AND b.source_namespace=NEW.source_namespace AND b.contract->>'schema'='packproof.typed-source-batch/v2' AND r.source_event_id=NEW.source_event_id AND r.source_revision=NEW.source_revision AND r.payload_sha256=NEW.payload_sha256) THEN RAISE EXCEPTION 'Source identity does not match its preserved version-two original stream'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_typed_source_identity_v2_scope BEFORE INSERT ON record_typed_source_identities_v2 FOR EACH ROW EXECUTE FUNCTION record_typed_source_identity_v2_scope();
