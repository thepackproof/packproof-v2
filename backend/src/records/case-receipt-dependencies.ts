import {currentCaseObservationSql} from './cases.js';

/** Receipt metadata can affect a case through an accepted row or through the
 * exact successor predicates used to hide an older case row. Do not require a
 * successor to be currently allocated to the old case, or omit older history.
 * The case must already be authorized. Indirect successors can have another
 * allocation or scope; callers may expose only an opaque dependency result. */
export function caseReceiptAffectsSql(batchAlias:string,caseExpression:string,connectionExpression?:string):string {
 const connection=(row:string)=>connectionExpression?` AND EXISTS(SELECT 1 FROM record_typed_batches dependency_original_batch WHERE dependency_original_batch.id=${row}.batch_id AND dependency_original_batch.connection_id=${connectionExpression})`:'';
 return `(EXISTS(SELECT 1 FROM record_typed_rows dependency_direct WHERE dependency_direct.batch_id=${batchAlias}.id AND ${currentCaseObservationSql('dependency_direct',caseExpression)}${connection('dependency_direct')})
 OR EXISTS(SELECT 1 FROM record_typed_rows dependency_changed JOIN record_typed_rows dependency_old ON dependency_old.id=dependency_changed.supersedes_id WHERE dependency_changed.batch_id=${batchAlias}.id AND dependency_changed.status IN ('accepted_linked','accepted_unlinked') AND ${currentCaseObservationSql('dependency_old',caseExpression)}${connection('dependency_old')})
 OR EXISTS(SELECT 1 FROM record_typed_snapshot_versions dependency_later JOIN record_typed_snapshot_versions dependency_prior ON dependency_later.organization_id=dependency_prior.organization_id AND dependency_later.environment=dependency_prior.environment AND dependency_later.connection_id=dependency_prior.connection_id AND dependency_later.location_id=dependency_prior.location_id AND dependency_later.subscription_id=dependency_prior.subscription_id AND dependency_later.source_namespace=dependency_prior.source_namespace AND dependency_later.source_event_id=dependency_prior.source_event_id AND dependency_later.source_as_of>dependency_prior.source_as_of JOIN record_typed_rows dependency_snapshot_changed ON dependency_snapshot_changed.id=dependency_later.observation_id JOIN record_typed_rows dependency_snapshot_old ON dependency_snapshot_old.id=dependency_prior.observation_id WHERE dependency_snapshot_changed.batch_id=${batchAlias}.id AND dependency_snapshot_changed.status IN ('accepted_linked','accepted_unlinked') AND ${currentCaseObservationSql('dependency_snapshot_old',caseExpression)}${connection('dependency_snapshot_old')}))`;
}
