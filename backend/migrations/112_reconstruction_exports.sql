CREATE TABLE record_reconstruction_exports (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL, organization_id TEXT NOT NULL, environment TEXT NOT NULL,
 projection_version TEXT NOT NULL, profile TEXT NOT NULL, actor_membership_id TEXT NOT NULL REFERENCES platform_memberships(id),
 payload_canonical TEXT NOT NULL, payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(case_id,organization_id,environment) REFERENCES record_cases(id,organization_id,environment),
 UNIQUE(case_id,actor_membership_id,payload_sha256)
);
CREATE TRIGGER record_reconstruction_export_immutable BEFORE UPDATE OR DELETE ON record_reconstruction_exports FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE INDEX record_reconstruction_export_case ON record_reconstruction_exports(case_id,created_at,id);
-- Retention decisions record policy, holds and unavailability without rewriting
-- original receipts or claiming that protected storage/backups were erased.
CREATE TABLE record_typed_retention_events (
 id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,organization_id TEXT NOT NULL,environment TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('policy_assigned','hold','release_hold','disposition_requested','unavailable')),
 policy JSONB,reason TEXT NOT NULL,related_event_id TEXT REFERENCES record_typed_retention_events(id),
 actor_user_id TEXT NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(batch_id,organization_id,environment) REFERENCES record_typed_batches(id,organization_id,environment)
);
CREATE TRIGGER record_typed_retention_event_immutable BEFORE UPDATE OR DELETE ON record_typed_retention_events FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE INDEX record_typed_retention_batch ON record_typed_retention_events(batch_id,created_at,id);
