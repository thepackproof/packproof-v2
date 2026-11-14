-- Measured accepted-event history lookups filter the raw event identity before
-- applying the existing exact batch/source/case scope. Preserve those predicates
-- and all row/constraint/permission semantics; only add their lookup path.
CREATE INDEX record_typed_rows_accepted_event_batch
 ON record_typed_rows(source_event_id,batch_id)
 WHERE status IN ('accepted_linked','accepted_unlinked');
