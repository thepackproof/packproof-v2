-- A derived projection can recur after a temporary source-health change.
-- Preserve each evaluation transition without rewriting its earlier visit.
ALTER TABLE record_case_issue_evaluations
 DROP CONSTRAINT record_case_issue_evaluations_issue_id_projection_version_key;
CREATE INDEX record_case_issue_evaluation_projection_lookup
 ON record_case_issue_evaluations(issue_id,projection_version);

-- Verified CSV snapshot controls retain their actual source timestamp in a
-- typed, indexed column. Historical rows remain unknown; no boundary is inferred.
ALTER TABLE record_typed_batches ADD COLUMN csv_snapshot_boundary_at TIMESTAMPTZ;
ALTER TABLE record_typed_batches ADD CONSTRAINT record_csv_snapshot_boundary_match CHECK(
 csv_snapshot_boundary_at IS NULL OR (
  original_media_type='text/csv'
  AND
  contract->>'schema'='packproof.typed-source-batch/v2'
  AND contract->'completeness'->>'kind'='snapshot'
  AND contract->'completeness'->>'asOf' IS NOT NULL
  AND csv_snapshot_boundary_at=(contract->'completeness'->>'asOf')::timestamptz
  AND contract->'completeness'->>'marker' IS NOT NULL
  AND length(contract->'completeness'->>'marker')>0
 ) IS TRUE
);
CREATE TRIGGER record_csv_snapshot_boundary_immutable
 BEFORE UPDATE OF csv_snapshot_boundary_at ON record_typed_batches
 FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE INDEX record_typed_batch_csv_boundary
 ON record_typed_batches(subscription_id,configuration_revision,csv_snapshot_boundary_at DESC,received_at DESC,id DESC)
 WHERE csv_snapshot_boundary_at IS NOT NULL AND state='succeeded' AND csv_snapshot_boundary_at<=received_at;
CREATE INDEX record_typed_batch_csv_unresolved
 ON record_typed_batches(subscription_id,configuration_revision,state,received_at,id)
 WHERE state<>'succeeded' OR csv_snapshot_boundary_at IS NULL;
CREATE INDEX record_typed_batch_csv_latest_live
 ON record_typed_batches(subscription_id,configuration_revision,received_at DESC,id DESC)
 WHERE COALESCE(contract->'collectionContext'->>'kind','')<>'historical_backfill';
