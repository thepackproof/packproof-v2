-- Durable, bounded optional shipment projection. Original observations and
-- human source grants remain immutable; only derived work progress can change.
CREATE TABLE record_typed_shipment_work (
 batch_id TEXT NOT NULL,case_id TEXT NOT NULL,organization_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 connection_id TEXT NOT NULL,location_id TEXT NOT NULL,operator_membership_id TEXT NOT NULL,
 witness_observation_id TEXT NOT NULL REFERENCES record_typed_rows(id),created_at TIMESTAMPTZ NOT NULL,
 work_revision BIGINT NOT NULL DEFAULT 1 CHECK(work_revision>0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','unavailable')),
 cursor_key TEXT CHECK(length(cursor_key)<=128),case_revision BIGINT CHECK(case_revision>0),
 next_attempt_at TIMESTAMPTZ NOT NULL,error_code TEXT CHECK(length(error_code)<=100),
 processed_groups INTEGER NOT NULL DEFAULT 0 CHECK(processed_groups>=0),
 linked_groups INTEGER NOT NULL DEFAULT 0 CHECK(linked_groups>=0 AND linked_groups<=processed_groups),
 updated_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(batch_id,case_id),
 FOREIGN KEY(batch_id,organization_id,environment) REFERENCES record_typed_batches(id,organization_id,environment),
 FOREIGN KEY(case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment)
);
CREATE INDEX record_typed_shipment_work_due ON record_typed_shipment_work(next_attempt_at,batch_id,case_id) WHERE state='pending';
CREATE INDEX record_typed_shipment_work_case ON record_typed_shipment_work(organization_id,environment,connection_id,location_id,operator_membership_id,case_id,state);
CREATE FUNCTION record_typed_shipment_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(
   SELECT 1 FROM record_typed_batches b JOIN record_typed_rows r ON r.batch_id=b.id
   JOIN record_cases c ON c.id=NEW.case_id
   WHERE b.id=NEW.batch_id AND r.id=NEW.witness_observation_id
    AND b.organization_id=NEW.organization_id AND b.environment=NEW.environment
    AND b.connection_id=NEW.connection_id AND b.location_id=NEW.location_id
    AND b.operator_membership_id=NEW.operator_membership_id
    AND c.organization_id=b.organization_id AND c.environment=b.environment
    AND c.location_id=b.location_id AND c.operator_membership_id=b.operator_membership_id
    AND r.status IN ('accepted_linked','accepted_unlinked')
    AND ((NOT EXISTS(SELECT 1 FROM record_case_row_projections p WHERE p.observation_id=r.id)
      AND r.case_id=c.id AND r.status='accepted_linked')
     OR EXISTS(SELECT 1 FROM record_case_row_projections p WHERE p.observation_id=r.id AND p.case_id=c.id AND p.state='linked'
      AND NOT EXISTS(SELECT 1 FROM record_case_row_projections successor WHERE successor.supersedes_id=p.id)))
  ) THEN RAISE EXCEPTION 'Shipment work does not match its original source and current case witness'; END IF;
 ELSE
  IF ROW(NEW.batch_id,NEW.case_id,NEW.organization_id,NEW.environment,NEW.connection_id,NEW.location_id,NEW.operator_membership_id,NEW.witness_observation_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.batch_id,OLD.case_id,OLD.organization_id,OLD.environment,OLD.connection_id,OLD.location_id,OLD.operator_membership_id,OLD.witness_observation_id,OLD.created_at)
   THEN RAISE EXCEPTION 'Shipment work original scope and witness are immutable'; END IF;
  IF NEW.work_revision<>OLD.work_revision+1 THEN RAISE EXCEPTION 'Shipment work revision must advance exactly once'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_typed_shipment_work_scope BEFORE INSERT OR UPDATE ON record_typed_shipment_work FOR EACH ROW EXECUTE FUNCTION record_typed_shipment_work_guard();
CREATE TRIGGER record_typed_shipment_work_immutable_delete BEFORE DELETE ON record_typed_shipment_work FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
