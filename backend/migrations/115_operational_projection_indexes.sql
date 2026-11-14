-- Read acceleration is derived state. Immutable source rows and association
-- decisions remain authoritative and can rebuild these counters and caches.
CREATE TABLE record_source_projection_counters (
 subscription_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,environment TEXT NOT NULL,
 location_id TEXT NOT NULL,operator_membership_id TEXT NOT NULL,
 received_count BIGINT NOT NULL DEFAULT 0,processing_count BIGINT NOT NULL DEFAULT 0,
 linked_count BIGINT NOT NULL DEFAULT 0,unlinked_count BIGINT NOT NULL DEFAULT 0,
 duplicate_count BIGINT NOT NULL DEFAULT 0,conflict_count BIGINT NOT NULL DEFAULT 0,
 quarantined_count BIGINT NOT NULL DEFAULT 0,rejected_count BIGINT NOT NULL DEFAULT 0,
 unknown_time_count BIGINT NOT NULL DEFAULT 0,ready BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(subscription_id,organization_id,environment) REFERENCES record_source_subscriptions(id,organization_id,environment),
 CHECK(received_count>=0 AND processing_count>=0 AND linked_count>=0 AND unlinked_count>=0 AND duplicate_count>=0 AND conflict_count>=0 AND quarantined_count>=0 AND rejected_count>=0 AND unknown_time_count>=0),
 CHECK(received_count=processing_count+linked_count+unlinked_count+duplicate_count+conflict_count+quarantined_count+rejected_count)
);
CREATE FUNCTION record_source_projection_counter_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; prior_status text; prior_unknown integer; next_unknown integer;
BEGIN
 IF TG_OP='UPDATE' AND NEW.status=OLD.status AND NEW.history_eligibility=OLD.history_eligibility THEN RETURN NEW; END IF;
 SELECT subscription_id,organization_id,environment,location_id,operator_membership_id INTO b FROM record_typed_batches WHERE id=NEW.batch_id;
 PERFORM pg_advisory_xact_lock(1347438166,hashtext(b.subscription_id));
 INSERT INTO record_source_projection_counters(subscription_id,organization_id,environment,location_id,operator_membership_id,updated_at)
 VALUES(b.subscription_id,b.organization_id,b.environment,b.location_id,b.operator_membership_id,NEW.received_at) ON CONFLICT DO NOTHING;
 IF NOT (SELECT ready FROM record_source_projection_counters WHERE subscription_id=b.subscription_id) THEN RETURN NEW; END IF;
 prior_status:=CASE WHEN TG_OP='UPDATE' THEN OLD.status ELSE '' END;
 prior_unknown:=CASE WHEN TG_OP='UPDATE' AND OLD.history_eligibility='unknown' AND OLD.status IN ('accepted_linked','accepted_unlinked') THEN 1 ELSE 0 END;
 next_unknown:=CASE WHEN NEW.history_eligibility='unknown' AND NEW.status IN ('accepted_linked','accepted_unlinked') THEN 1 ELSE 0 END;
 UPDATE record_source_projection_counters SET
 received_count=received_count+CASE WHEN TG_OP='INSERT' THEN 1 ELSE 0 END,
 processing_count=processing_count+(NEW.status='processing')::integer-(prior_status='processing')::integer,
 linked_count=linked_count+(NEW.status='accepted_linked')::integer-(prior_status='accepted_linked')::integer,
 unlinked_count=unlinked_count+(NEW.status='accepted_unlinked')::integer-(prior_status='accepted_unlinked')::integer,
 duplicate_count=duplicate_count+(NEW.status='duplicate')::integer-(prior_status='duplicate')::integer,
 conflict_count=conflict_count+(NEW.status='conflict')::integer-(prior_status='conflict')::integer,
 quarantined_count=quarantined_count+(NEW.status='quarantined')::integer-(prior_status='quarantined')::integer,
 rejected_count=rejected_count+(NEW.status='rejected')::integer-(prior_status='rejected')::integer,
 unknown_time_count=unknown_time_count+next_unknown-prior_unknown,updated_at=NEW.received_at
 WHERE subscription_id=b.subscription_id;
 RETURN NEW;
END $$;
CREATE TRIGGER record_source_projection_counter_change AFTER INSERT OR UPDATE OF status,history_eligibility ON record_typed_rows FOR EACH ROW EXECUTE FUNCTION record_source_projection_counter_change();

CREATE TABLE record_case_projection_state (
 case_id TEXT PRIMARY KEY REFERENCES record_cases(id),case_revision BIGINT NOT NULL,
 projection_version TEXT NOT NULL,source_signature TEXT NOT NULL,
 summary JSONB NOT NULL,source_keys JSONB NOT NULL,source_snapshot JSONB NOT NULL,
 rule_capabilities JSONB NOT NULL,comparison_count INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,valid_until TIMESTAMPTZ NOT NULL,next_check_at TIMESTAMPTZ NOT NULL,
 error_code TEXT,
 CHECK(comparison_count>=0)
);
CREATE INDEX record_case_projection_due ON record_case_projection_state(next_check_at,case_id);
CREATE TABLE record_case_projection_comparisons (
 case_id TEXT NOT NULL REFERENCES record_cases(id),projection_version TEXT NOT NULL,
 comparison_id TEXT NOT NULL,position INTEGER NOT NULL,data JSONB NOT NULL,
 PRIMARY KEY(case_id,projection_version,comparison_id),UNIQUE(case_id,projection_version,position),CHECK(position>=0)
);
CREATE TRIGGER record_case_projection_comparison_immutable BEFORE UPDATE OR DELETE ON record_case_projection_comparisons FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE INDEX record_case_assertion_active_subject ON record_case_assertions(case_id,property,entity_id,observation_id);
CREATE INDEX record_case_relation_source_page ON record_case_relations(case_id,assertion_row_id,id);
CREATE INDEX record_typed_row_received_case_page ON record_typed_rows(case_id,received_at,id) WHERE status='accepted_linked';
CREATE INDEX record_typed_row_case_source ON record_typed_rows(batch_id,case_id,status);
CREATE INDEX record_typed_batch_subscription_cursor ON record_typed_batches(subscription_id,received_at DESC,id DESC);
CREATE INDEX record_case_projection_row_current ON record_case_row_projections(case_id,state,created_at,observation_id);
