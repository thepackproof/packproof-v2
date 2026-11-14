import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {canonicalize} from '../canonical.js';
import {newId} from '../ids.js';
import {sha256Hex} from '../hash.js';
import {reauthorizePartner,authorizePartnerProof,strictBody,type PartnerActor} from '../platform/organizations.js';
import {textField} from '../platform/tenants.js';
import {idempotent} from '../platform/idempotency.js';
import {reauthorizeRecordWorkspace,requireRecordLocation,type RecordWorkspace} from './access.js';
import type {TypedSourceBatch,TypedSourceObservation,TypedSourceReference} from './source-contracts.js';
import {SOURCE_ENTITY_TYPES} from './source-profiles.js';
import {requireReconstructionFeature,reconstructionFeatureEnabled} from './reconstruction-features.js';
import {importPartnerOrder} from '../platform/partner-proofs.js';
import {appendAudit} from '../domain/audit.js';
import {explicitInstant} from './csv-semantics.js';

export interface OperationalCaseRow {
 id:string;organization_id:string;environment:'sandbox'|'live';location_id:string;location_key:string;
 operator_membership_id:string;root_namespace:string;root_type:'order'|'shipment'|'return';root_external_id:string;
 revision:number|string;created_at:string|Date;updated_at:string|Date;
}
const unavailable=()=>new DomainError('CASE_NOT_FOUND','Operational case not found',404);
const refKey=(r:TypedSourceReference)=>canonicalize([r.namespace,r.type,r.externalId,(r as TypedSourceReference&{parentExternalId?:string}).parentExternalId??'']);
const operationalShipmentKey=(r:TypedSourceReference,locationId:string)=>`typed:v1:${sha256Hex(canonicalize([locationId,r.namespace,r.type,r.externalId]))}`;

/** Internal SQL predicates shared by every case reader, extract, and retention
 * review. Once a partition ledger exists it overrides the legacy primary-case
 * pointer, including removed decisions. A partial row may have linked subsets. */
/** Indexed source-row candidates; the current predicate below decides eligibility. */
export function observationCaseCandidatesSql(rowAlias:string) {return `(SELECT ${rowAlias}.case_id WHERE ${rowAlias}.case_id IS NOT NULL UNION SELECT candidate.case_id FROM record_case_row_projections candidate WHERE candidate.observation_id=${rowAlias}.id)`;}
export function currentCaseObservationSql(rowAlias:string,caseExpression:string) {
 return `(${rowAlias}.status IN ('accepted_linked','accepted_unlinked') AND EXISTS(SELECT 1 FROM record_typed_batches observation_scope_batch JOIN record_cases observation_scope_case ON observation_scope_case.id=${caseExpression} AND observation_scope_case.organization_id=observation_scope_batch.organization_id AND observation_scope_case.environment=observation_scope_batch.environment AND observation_scope_case.location_id=observation_scope_batch.location_id AND observation_scope_case.operator_membership_id=observation_scope_batch.operator_membership_id WHERE observation_scope_batch.id=${rowAlias}.batch_id) AND ((NOT EXISTS(SELECT 1 FROM record_case_row_projections projection_any WHERE projection_any.observation_id=${rowAlias}.id) AND ${rowAlias}.case_id=${caseExpression} AND ${rowAlias}.status='accepted_linked') OR EXISTS(SELECT 1 FROM record_case_row_projections projection_current WHERE projection_current.observation_id=${rowAlias}.id AND projection_current.case_id=${caseExpression} AND projection_current.state='linked' AND NOT EXISTS(SELECT 1 FROM record_case_row_projections projection_successor WHERE projection_successor.supersedes_id=projection_current.id))))`;
}
export function currentCaseObservationProjectionSql(rowAlias:string,caseExpression:string) {
 return `COALESCE((SELECT projection_current.normalized FROM record_case_row_projections projection_current WHERE projection_current.observation_id=${rowAlias}.id AND projection_current.case_id=${caseExpression} AND projection_current.state='linked' AND NOT EXISTS(SELECT 1 FROM record_case_row_projections projection_successor WHERE projection_successor.supersedes_id=projection_current.id)),${rowAlias}.normalized)`;
}
export function caseObservationSupersededSql(rowIdExpression:string,caseExpression:string) {
 return `(EXISTS(SELECT 1 FROM record_typed_rows observation_successor WHERE observation_successor.supersedes_id=${rowIdExpression} AND observation_successor.status IN ('accepted_linked','accepted_unlinked')) OR EXISTS(SELECT 1 FROM record_typed_snapshot_versions snapshot_current JOIN record_typed_snapshot_versions snapshot_later ON snapshot_later.organization_id=snapshot_current.organization_id AND snapshot_later.environment=snapshot_current.environment AND snapshot_later.connection_id=snapshot_current.connection_id AND snapshot_later.location_id=snapshot_current.location_id AND snapshot_later.subscription_id=snapshot_current.subscription_id AND snapshot_later.source_namespace=snapshot_current.source_namespace AND snapshot_later.source_event_id=snapshot_current.source_event_id AND snapshot_later.source_as_of>snapshot_current.source_as_of JOIN record_typed_rows snapshot_row ON snapshot_row.id=snapshot_later.observation_id WHERE snapshot_current.observation_id=${rowIdExpression} AND snapshot_row.status IN ('accepted_linked','accepted_unlinked')))`;
}
export function currentCaseAssertionSql(assertionAlias:string,rowAlias:string,caseExpression:string) {
 return `(${currentCaseObservationSql(rowAlias,caseExpression)} AND (NOT EXISTS(SELECT 1 FROM record_case_row_projections assertion_projection_any WHERE assertion_projection_any.observation_id=${rowAlias}.id) OR EXISTS(SELECT 1 FROM record_case_row_projections assertion_projection WHERE assertion_projection.observation_id=${rowAlias}.id AND assertion_projection.case_id=${caseExpression} AND assertion_projection.state='linked' AND assertion_projection.assertion_ids ? ${assertionAlias}.id AND NOT EXISTS(SELECT 1 FROM record_case_row_projections assertion_projection_successor WHERE assertion_projection_successor.supersedes_id=assertion_projection.id))))`;
}
export function currentCaseRelationshipSql(relationshipAlias:string,rowAlias:string,caseExpression:string) {
 return `(${currentCaseObservationSql(rowAlias,caseExpression)} AND (NOT EXISTS(SELECT 1 FROM record_case_row_projections relationship_projection_any WHERE relationship_projection_any.observation_id=${rowAlias}.id) OR EXISTS(SELECT 1 FROM record_case_row_projections relationship_projection WHERE relationship_projection.observation_id=${rowAlias}.id AND relationship_projection.case_id=${caseExpression} AND relationship_projection.state='linked' AND relationship_projection.relationship_ids ? ${relationshipAlias}.id AND NOT EXISTS(SELECT 1 FROM record_case_row_projections relationship_projection_successor WHERE relationship_projection_successor.supersedes_id=relationship_projection.id))))`;
}

/** Entity history follows its currently retained per-case assertion or edge. */
export function currentCaseEntitySql(entityAlias='e') {
 return `(EXISTS(SELECT 1 FROM record_case_assertions entity_assertion JOIN record_typed_rows entity_source ON entity_source.id=entity_assertion.observation_id WHERE entity_assertion.entity_id=${entityAlias}.id AND entity_assertion.case_id=${entityAlias}.case_id AND ${currentCaseAssertionSql('entity_assertion','entity_source',`${entityAlias}.case_id`)}) OR EXISTS(SELECT 1 FROM record_case_relations entity_relation JOIN record_typed_rows entity_source ON entity_source.id=entity_relation.assertion_row_id WHERE entity_relation.case_id=${entityAlias}.case_id AND (entity_relation.from_entity_id=${entityAlias}.id OR entity_relation.to_entity_id=${entityAlias}.id) AND ${currentCaseRelationshipSql('entity_relation','entity_source',`${entityAlias}.case_id`)}))`;
}
/** Resolve current account and membership before filtering any case counts. */
export async function requireCaseWorkspace(db:Database,clock:Clock,w:RecordWorkspace,write=false) {
 requireReconstructionFeature('reconstruction');
 const current=await reauthorizeRecordWorkspace(db,{...w,authorizationClock:clock},write);
 if(current.partner){
  if(current.partner.delegationGrantId)throw new DomainError('CASE_LOCATION_GRANT_REQUIRED','Case access requires direct merchant authority until a delegated case/location profile is approved',403);
  if((await db.query('SELECT 1 FROM record_agent_installations WHERE principal_id=$1',[current.partner.principalId])).rows[0])throw new DomainError('AGENT_OPERATION_DENIED','An installation may read only its approved source receipts',403);
 }
 return current;
}
/** Apply this predicate before paging, searching, counting or traversing. */
export function caseScopeSql(w:RecordWorkspace,alias='c',start=1) {
 const p=(n:number)=>`$${start+n}`;
 return {sql:`${alias}.organization_id=${p(0)} AND ${alias}.environment=${p(1)} AND (${p(2)}::boolean=false OR ${alias}.operator_membership_id=${p(3)}) AND (${p(4)}::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.organization_id=${alias}.organization_id AND g.membership_id=${p(3)} AND g.location_id=${alias}.location_id))`,params:[w.organizationId,w.environment,!w.partner&&w.role==='OPERATOR',w.membershipId,w.locationScoped]};
}
export async function requireCaseAccess(db:Database,clock:Clock,w:RecordWorkspace,id:string,write=false):Promise<OperationalCaseRow> {
 const current=await requireCaseWorkspace(db,clock,w,write),scope=caseScopeSql(current);
 const row=(await db.query<OperationalCaseRow>(`SELECT c.* FROM record_cases c WHERE ${scope.sql} AND c.id=$${scope.params.length+1}`,[...scope.params,id])).rows[0];
 if(!row)throw unavailable();
 await requireRecordLocation(db,current,row.location_id);
 return row;
}

export interface CrossCaseSourcePolicy {schema:'packproof.cross-case-source-policy/v1';version:string;allowMultiOrderRows:true;partitionRule:'explicit_order_line_allocations';sharedEntityTypes:Array<'handling_unit'|'load'|'stop'>;sourceOwnerQualified:true;qualificationReference:string;}
export interface CaseWriteContext {organizationId:string;environment:'sandbox'|'live';locationId:string;operatorMembershipId:string;actor:PartnerActor;batchId:string;rowId:string;rowNumber:number;receivedAt:string;source:TypedSourceBatch;casePolicy?:CrossCaseSourcePolicy|null;}
async function bump(db:Database,clock:Clock,id:string,rowId:string|null,event='case.updated') {
 const c=(await db.query<{revision:string|number}>('UPDATE record_cases SET revision=revision+1,updated_at=$2 WHERE id=$1 RETURNING revision',[id,clock.now().toISOString()])).rows[0];
 await db.query('INSERT INTO record_case_outbox(id,case_id,revision,event_type,observation_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[newId('case_event'),id,c.revision,event,rowId,clock.now().toISOString()]);
}
/** Exact explicitly scoped anchors only. Lines, SKUs, clocks, loads and
 * tracking numbers cannot merge cases merely because one happens to exist. */
async function candidates(db:Database,x:CaseWriteContext,n:TypedSourceObservation) {
 const found=new Set<string>(),crosswalks:Record<string,unknown>[]=[];
 for(const r of n.references){
  const maps=(await db.query<{id:string;case_id:string;rule_version:string;reason:string}>(`SELECT m.id,m.case_id,m.rule_version,m.reason FROM record_case_crosswalks m JOIN record_cases c ON c.id=m.case_id
   WHERE m.organization_id=$1 AND m.environment=$2 AND m.location_id=$3 AND m.namespace=$4 AND m.entity_type=$5 AND m.external_id=$6 AND m.parent_external_id=$8
    AND c.operator_membership_id=$7 AND NOT EXISTS(SELECT 1 FROM record_case_crosswalks newer WHERE newer.supersedes_id=m.id) LIMIT 3`,[x.organizationId,x.environment,x.locationId,r.namespace,r.type,r.externalId,x.operatorMembershipId,r.parentExternalId??''])).rows;
  if(maps.length){for(const row of maps){found.add(row.case_id);crosswalks.push({id:row.id,caseId:row.case_id,ruleVersion:row.rule_version,reference:r});}continue;}
  if(reconstructionFeatureEnabled('crossCase')&&x.source.schema==='packproof.typed-source-batch/v2'&&x.casePolicy){
   const time=n.occurredAt??n.sourceAsOf;
   const approved=(await db.query<{id:string;left_namespace:string;right_namespace:string;rule_version:string}>(`SELECT m.id,m.left_namespace,m.right_namespace,m.rule_version FROM record_case_identity_rules m WHERE m.organization_id=$1 AND m.environment=$2 AND m.location_id=$3 AND m.entity_type=$4 AND ($5=m.left_namespace OR $5=m.right_namespace) AND NOT EXISTS(SELECT 1 FROM record_case_identity_rules successor WHERE successor.supersedes_id=m.id) AND ((m.effective_from IS NULL AND m.effective_until IS NULL) OR ($6::timestamptz IS NOT NULL AND (m.effective_from IS NULL OR m.effective_from<=$6) AND (m.effective_until IS NULL OR m.effective_until>$6))) LIMIT 21`,[x.organizationId,x.environment,x.locationId,r.type,r.namespace,time])).rows;
   if(approved.length>20)throw new DomainError('CASE_IDENTITY_MAPPING_LIMIT','Narrow the active approved namespace mappings before resolving this source',409);
   for(const mapping of approved){
    const namespace=mapping.left_namespace===r.namespace?mapping.right_namespace:mapping.left_namespace;
    const mapped=(await db.query<{id:string}>(`SELECT DISTINCT c.id FROM record_cases c LEFT JOIN record_case_entities e ON e.case_id=c.id WHERE c.organization_id=$1 AND c.environment=$2 AND c.location_id=$3 AND c.operator_membership_id=$4 AND ((c.root_namespace=$5 AND c.root_type=$6 AND c.root_external_id=$7 AND $8='') OR (e.namespace=$5 AND e.entity_type=$6 AND e.external_id=$7 AND e.parent_external_id=$8)) LIMIT 3`,[x.organizationId,x.environment,x.locationId,x.operatorMembershipId,namespace,r.type,r.externalId,r.parentExternalId??''])).rows;
    for(const row of mapped){found.add(row.id);crosswalks.push({id:mapping.id,caseId:row.id,ruleVersion:mapping.rule_version,reference:r,kind:'approved_exact_namespace_rule',parentScope:r.parentExternalId??null});}
   }
  }
  if(['order','shipment','return'].includes(r.type)){
   const rows=(await db.query<{id:string}>(`SELECT DISTINCT c.id FROM record_cases c LEFT JOIN record_case_entities e ON e.case_id=c.id
    WHERE c.organization_id=$1 AND c.environment=$2 AND c.location_id=$3 AND c.operator_membership_id=$7 AND
    ((c.root_namespace=$4 AND c.root_type=$5 AND c.root_external_id=$6) OR (e.namespace=$4 AND e.entity_type=$5 AND e.external_id=$6)) LIMIT 3`,[x.organizationId,x.environment,x.locationId,r.namespace,r.type,r.externalId,x.operatorMembershipId])).rows;
   for(const row of rows)found.add(row.id);
  }
 }
 return {ids:[...found].sort(),crosswalks};
}
async function createCase(db:Database,clock:Clock,x:CaseWriteContext,root:TypedSourceReference) {
 const id=newId('case'),now=clock.now().toISOString();
 const row=(await db.query<OperationalCaseRow>(`INSERT INTO record_cases(id,organization_id,environment,location_id,location_key,operator_membership_id,root_namespace,root_type,root_external_id,created_at,updated_at)
  VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT(organization_id,environment,location_key,root_namespace,root_type,root_external_id) DO NOTHING RETURNING *`,[id,x.organizationId,x.environment,x.locationId,x.operatorMembershipId,root.namespace,root.type,root.externalId,now])).rows[0];
 const result=row??(await db.query<OperationalCaseRow>('SELECT * FROM record_cases WHERE organization_id=$1 AND environment=$2 AND location_id=$3 AND root_namespace=$4 AND root_type=$5 AND root_external_id=$6',[x.organizationId,x.environment,x.locationId,root.namespace,root.type,root.externalId])).rows[0];
 if(result.operator_membership_id!==x.operatorMembershipId)throw new DomainError('CASE_OPERATOR_CONFLICT','This identity belongs to a different approved operator',409);
 return result.id;
}
async function materialize(db:Database,clock:Clock,x:CaseWriteContext,n:TypedSourceObservation,caseId:string,basis:unknown,partition?:{assertionIndexes:number[];relationshipIndexes:number[]}) {
 const prior=partition?undefined:(await db.query<{id:string;case_id:string}>(`SELECT d.id,d.case_id FROM record_case_association_decisions d WHERE d.observation_id=$1 AND NOT EXISTS(SELECT 1 FROM record_case_association_decisions newer WHERE newer.supersedes_id=d.id)`,[x.rowId])).rows[0];
 const state=(await db.query<{status:string;case_id:string}>('SELECT status,case_id FROM record_typed_rows WHERE id=$1',[x.rowId])).rows[0];
 if(!partition&&prior?.case_id===caseId&&state.status==='accepted_linked'&&state.case_id===caseId)return caseId;
 const entityIds=new Map<string,string>();
 const refs=[...n.references,...n.assertions.map(a=>a.subjectReference),...n.relationships.flatMap(r=>[r.from,r.to])];
 for(const r of refs){
  const key=refKey(r);if(entityIds.has(key))continue;
  const parent=(r as TypedSourceReference&{parentExternalId?:string}).parentExternalId??'';
  const entity=(await db.query<{id:string}>(`INSERT INTO record_case_entities(id,case_id,organization_id,environment,namespace,entity_type,external_id,parent_external_id,receipt_id,row_number,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(case_id,namespace,entity_type,external_id,parent_external_id) DO NOTHING RETURNING id`,[newId('case_entity'),caseId,x.organizationId,x.environment,r.namespace,r.type,r.externalId,parent,x.rowId,x.rowNumber,x.receivedAt])).rows[0]
   ??(await db.query<{id:string}>('SELECT id FROM record_case_entities WHERE case_id=$1 AND namespace=$2 AND entity_type=$3 AND external_id=$4 AND parent_external_id=$5',[caseId,r.namespace,r.type,r.externalId,parent])).rows[0];
  entityIds.set(key,entity.id);
 }
 for(const [i,a]of (n.observationKind==='tombstone'?[]:n.assertions).entries()){
  const id=`assertion_${sha256Hex(canonicalize([x.rowId,caseId,partition?.assertionIndexes[i]??i]))}`;
  await db.query(`INSERT INTO record_case_assertions(id,case_id,entity_id,batch_id,row_number,observation_id,connection_id,source_namespace,property,value,unit,source_locator,mapping_version,source_revision,occurred_at,source_as_of,time_quality,origin,received_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb,$19) ON CONFLICT(id) DO NOTHING`,[id,caseId,entityIds.get(refKey(a.subjectReference)),x.batchId,x.rowNumber,x.rowId,x.source.connectionId,x.source.sourceNamespace,a.property,JSON.stringify(a.value),typeof a.value==='object'?a.value.unit:null,JSON.stringify(a.sourceLocator),x.source.mappingVersion,n.sourceRevision,n.occurredAt,n.sourceAsOf,n.timeQuality,JSON.stringify({originSystem:n.originSystem,copiedFromSource:n.copiedFromSource}),x.receivedAt]);
 }
 for(const [i,r]of (n.observationKind==='tombstone'?[]:n.relationships).entries())await db.query(`INSERT INTO record_case_relations(id,case_id,from_entity_id,to_entity_id,relation_type,quantity,assertion_row_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(id) DO NOTHING`,[`relation_${sha256Hex(canonicalize([x.rowId,caseId,partition?.relationshipIndexes[i]??i]))}`,caseId,entityIds.get(refKey(r.from)),entityIds.get(refKey(r.to)),r.type,JSON.stringify(r.quantity),x.rowId,x.receivedAt]);
 if(!partition){
  if(!prior||prior.case_id!==caseId)await db.query('INSERT INTO record_case_association_decisions(id,observation_id,case_id,supersedes_id,basis,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[newId('case_decision'),x.rowId,caseId,prior?.id??null,JSON.stringify(basis),x.actor.actorUserId,clock.now().toISOString()]);
  await db.query("UPDATE record_typed_rows SET status='accepted_linked',case_id=$2,error_code=NULL WHERE id=$1",[x.rowId,caseId]);
 }
 if(prior&&prior.case_id!==caseId)await bump(db,clock,prior.case_id,x.rowId,'association.corrected');
 await bump(db,clock,caseId,x.rowId,prior&&prior.case_id!==caseId?'association.corrected':'case.updated');
 // Existing shipment Proofs are members only after current Proof authorization.
 // Typed imports never synthesize a transaction title, quantity or shipment.
 for(const r of n.references.filter(r=>r.type==='shipment')){
  const members=(await db.query<{proof_id:string}>(`SELECT DISTINCT b.proof_id FROM platform_external_bindings b JOIN record_state s ON s.proof_id=b.proof_id JOIN platform_proof_ownership o ON o.proof_id=b.proof_id WHERE b.merchant_id=$1 AND b.environment=$2 AND b.integration_account_id=$3 AND b.resource_type='SHIPMENT' AND b.external_id=$4 AND s.location_id=$5 AND o.operator_membership_id=$6`,[x.organizationId,x.environment,x.source.connectionId,operationalShipmentKey(r,x.locationId),x.locationId,x.operatorMembershipId])).rows;
  if(members.length===1){await authorizePartnerProof(db,clock,x.actor,members[0].proof_id,'proofs:read');await db.query('INSERT INTO record_case_members(case_id,proof_id,organization_id,environment,source_row_id,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[caseId,members[0].proof_id,x.organizationId,x.environment,x.rowId,clock.now().toISOString()]);}
 }
 return caseId;
}

export async function applyOperationalObservation(db:Database,clock:Clock,x:CaseWriteContext,n:TypedSourceObservation) {
 await db.query('SELECT pg_advisory_xact_lock(1347438158,hashtext($1))',[x.batchId]);
 await db.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([x.organizationId,x.environment,x.locationId])]);
 if(reconstructionFeatureEnabled('crossCase')&&String(x.source.schema)==='packproof.typed-source-batch/v2'&&x.casePolicy?.sourceOwnerQualified&&x.casePolicy.allowMultiOrderRows)return applyPartitionedObservation(db,clock,x,n);
 return applyLegacyObservation(db,clock,x,n);
}
async function applyLegacyObservation(db:Database,clock:Clock,x:CaseWriteContext,n:TypedSourceObservation) {
 const orderRoots=n.references.filter(r=>r.type==='order'),lineParents=new Set(n.references.filter(r=>r.type==='order_line').map(r=>r.parentExternalId));
 if(orderRoots.length>1||lineParents.size>1){await db.query("UPDATE record_typed_rows SET status='accepted_unlinked',case_id=NULL,error_code='MULTI_ORDER_RECONSTRUCTION_UNQUALIFIED' WHERE id=$1",[x.rowId]);return null;}
 const resolution=await candidates(db,x,n);let ids=resolution.ids;
 if(!ids.length&&x.source.sourceProfile==='packproof.order-lines/v1'){
  const roots=n.references.filter(r=>r.type==='order'&&r.namespace===x.source.sourceNamespace);
  if(roots.length===1)ids=[await createCase(db,clock,x,roots[0])];
 }
 if(ids.length!==1){await db.query("UPDATE record_typed_rows SET status='accepted_unlinked',case_id=NULL,error_code=$2 WHERE id=$1",[x.rowId,ids.length?'SOURCE_REFERENCE_AMBIGUOUS':'SOURCE_REFERENCE_UNRESOLVED']);return null;}
 const root=(await db.query<OperationalCaseRow>('SELECT * FROM record_cases WHERE id=$1',[ids[0]])).rows[0];
 if(root.root_type==='order'&&root.root_namespace===x.source.sourceNamespace&&((orderRoots.length===1&&orderRoots[0].externalId!==root.root_external_id)||[...lineParents].some(p=>p!==root.root_external_id))){await db.query("UPDATE record_typed_rows SET status='accepted_unlinked',case_id=NULL,error_code='ORDER_PARENT_REFERENCE_CONFLICT' WHERE id=$1",[x.rowId]);return null;}
 return materialize(db,clock,x,n,ids[0],{ruleVersion:'packproof.case-identity/v1',kind:resolution.crosswalks.length?'approved_crosswalk':'exact_scoped_reference',crosswalks:resolution.crosswalks,references:n.references.filter(r=>['order','shipment','return'].includes(r.type))});
}

export interface ObservationPartition {root:TypedSourceReference;observation:TypedSourceObservation;assertionIndexes:number[];relationshipIndexes:number[];}
/** Explicit parent-line and allocation edges determine scope. Shared transport
 * references propagate ownership but never collapse distinct order roots. */
export function partitionOperationalObservation(n:TypedSourceObservation,sharedEntityTypes:readonly string[]):{partitions:ObservationPartition[];unassignedAssertions:number[];unassignedRelationships:number[]} {
 const roots=n.references.filter(r=>r.type==='order'),owners=new Map<string,Set<string>>(),rootMap=new Map(roots.map(r=>[refKey(r),r]));
 const add=(reference:TypedSourceReference,values:Iterable<string>)=>{const key=refKey(reference),set=owners.get(key)??new Set<string>(),before=set.size;for(const value of values)set.add(value);owners.set(key,set);return set.size!==before;};
 for(const root of roots)add(root,[refKey(root)]);
 for(const line of n.references.filter(r=>r.type==='order_line')){const parent=roots.find(r=>r.namespace===line.namespace&&r.externalId===line.parentExternalId);if(parent)add(line,[refKey(parent)]);}
 for(let pass=0;pass<n.references.length+1;pass++){
  let changed=false;
  for(const edge of n.relationships){
   if(edge.type==='fulfills'&&edge.from.type==='shipment'&&edge.to.type==='order_line')changed=add(edge.from,owners.get(refKey(edge.to))??[])||changed;
   if(edge.type==='allocated_to'&&edge.from.type==='order_line'&&edge.to.type==='handling_unit')changed=add(edge.to,owners.get(refKey(edge.from))??[])||changed;
   if(edge.type==='contains'&&edge.from.type==='handling_unit'){
    changed=add(edge.from,owners.get(refKey(edge.to))??[])||changed;
   }
   if(edge.type==='loaded_on'&&['shipment','handling_unit'].includes(edge.from.type)&&edge.to.type==='load')changed=add(edge.to,owners.get(refKey(edge.from))??[])||changed;
   if(edge.type==='delivered_at'&&edge.from.type==='shipment'&&edge.to.type==='stop')changed=add(edge.to,owners.get(refKey(edge.from))??[])||changed;
   if(edge.type==='return_of'&&edge.from.type==='return'&&edge.to.type==='order_line')changed=add(edge.from,owners.get(refKey(edge.to))??[])||changed;
   if(edge.type==='tracks'&&edge.from.type==='tracking'&&edge.to.type==='shipment')changed=add(edge.from,owners.get(refKey(edge.to))??[])||changed;
  }
  if(!changed)break;
 }
 const assignedAssertions=new Set<number>(),assignedRelationships=new Set<number>(),partitions:ObservationPartition[]=[];
 for(const [rootKey,root]of rootMap){
  const eligible=(r:TypedSourceReference)=>owners.get(refKey(r))?.has(rootKey)??false;
  const assertionIndexes=n.assertions.flatMap((assertion,index)=>{
   const ownership=owners.get(refKey(assertion.subjectReference));
   // A whole-pallet/shipment count is not a per-order count. Preserve that
   // unsupported assertion as pending rather than copying it into every case.
   if(!ownership?.has(rootKey)||ownership.size>1&&(typeof assertion.value==='object'||!['shipment',...sharedEntityTypes].includes(assertion.subjectReference.type)))return [];
   assignedAssertions.add(index);return [index];
  });
  const relationshipIndexes=n.relationships.flatMap((edge,index)=>{if(!eligible(edge.from)||!eligible(edge.to))return [];assignedRelationships.add(index);return [index];});
  const references=n.references.filter(eligible);
  // Unowned roots remain separate and visible as pending instead of joining
  // whichever order is already known to the database.
  partitions.push({root,assertionIndexes,relationshipIndexes,observation:{...n,references,assertions:assertionIndexes.map(i=>n.assertions[i]),relationships:relationshipIndexes.map(i=>n.relationships[i])}});
 }
 return {partitions,unassignedAssertions:n.assertions.map((_,i)=>i).filter(i=>!assignedAssertions.has(i)),unassignedRelationships:n.relationships.map((_,i)=>i).filter(i=>!assignedRelationships.has(i))};
}
interface PartitionDecision {id:string;case_id:string;state:'linked'|'removed';normalized:TypedSourceObservation;assertion_indexes:number[];relationship_indexes:number[];basis:unknown;}
async function partitionHeads(db:Database,rowId:string){return (await db.query<PartitionDecision>(`SELECT p.* FROM record_case_row_projections p WHERE p.observation_id=$1 AND NOT EXISTS(SELECT 1 FROM record_case_row_projections successor WHERE successor.supersedes_id=p.id) ORDER BY p.case_id`,[rowId])).rows;}
async function recordPartition(db:Database,clock:Clock,x:CaseWriteContext,caseId:string,state:'linked'|'removed',partition:ObservationPartition,basis:unknown,prior?:PartitionDecision){
 const content={normalized:partition.observation,assertionIndexes:partition.assertionIndexes,relationshipIndexes:partition.relationshipIndexes,state,basis};
 if(prior&&canonicalize({normalized:prior.normalized,assertionIndexes:prior.assertion_indexes,relationshipIndexes:prior.relationship_indexes,state:prior.state,basis:prior.basis})===canonicalize(content))return false;
 const assertionIds=partition.assertionIndexes.map(i=>`assertion_${sha256Hex(canonicalize([x.rowId,caseId,i]))}`),relationshipIds=partition.relationshipIndexes.map(i=>`relation_${sha256Hex(canonicalize([x.rowId,caseId,i]))}`);
 await db.query(`INSERT INTO record_case_row_projections(id,observation_id,case_id,organization_id,environment,location_id,operator_membership_id,state,normalized,assertion_indexes,relationship_indexes,assertion_ids,relationship_ids,basis,supersedes_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16)`,[newId('case_partition'),x.rowId,caseId,x.organizationId,x.environment,x.locationId,x.operatorMembershipId,state,JSON.stringify(partition.observation),JSON.stringify(partition.assertionIndexes),JSON.stringify(partition.relationshipIndexes),JSON.stringify(assertionIds),JSON.stringify(relationshipIds),JSON.stringify(basis),prior?.id??null,clock.now().toISOString()]);return true;
}
async function resolvePartition(db:Database,clock:Clock,x:CaseWriteContext,partition:ObservationPartition){
 // Resolve the explicit order root before any shipment child. A known child
 // cannot turn unseen order B into known order A.
 const rootOnly={...partition.observation,references:[partition.root],assertions:[],relationships:[]};
 const resolution=await candidates(db,x,rootOnly);let ids=resolution.ids;
 if(!ids.length&&x.source.sourceProfile==='packproof.order-lines/v1')ids=[await createCase(db,clock,x,partition.root)];
 if(ids.length!==1)return null;
 const candidate=(await db.query<OperationalCaseRow>('SELECT * FROM record_cases WHERE id=$1',[ids[0]])).rows[0];
 if(!candidate||candidate.operator_membership_id!==x.operatorMembershipId||candidate.location_id!==x.locationId||candidate.organization_id!==x.organizationId||candidate.environment!==x.environment)throw new DomainError('CASE_PARTITION_SCOPE_DENIED','A source partition cannot expand its approved scope',403);
 return {caseId:candidate.id,basis:{ruleVersion:'packproof.case-partition/v1',kind:resolution.crosswalks.length?'approved_crosswalk':'explicit_parent_order',root:partition.root,crosswalks:resolution.crosswalks,sourcePolicyVersion:x.casePolicy!.version,assertionIndexes:partition.assertionIndexes,relationshipIndexes:partition.relationshipIndexes}};
}
async function updateSharedLinks(db:Database,clock:Clock,x:CaseWriteContext,linked:Array<{caseId:string;partition:ObservationPartition}>){
 const existing=(await db.query<{id:string;left_case_id:string;right_case_id:string;shared_reference:TypedSourceReference;state:string}>(`SELECT l.* FROM record_case_links l WHERE l.observation_id=$1 AND NOT EXISTS(SELECT 1 FROM record_case_links successor WHERE successor.supersedes_id=l.id)`,[x.rowId])).rows;
 const desired=new Map<string,{left:string;right:string;reference:TypedSourceReference}>();
 for(let i=0;i<linked.length;i++)for(let j=i+1;j<linked.length;j++){
  const a=linked[i],b=linked[j];if(a.caseId===b.caseId)continue;
  const keys=new Set(a.partition.observation.references.filter(r=>x.casePolicy!.sharedEntityTypes.includes(r.type as never)).map(refKey));
  for(const reference of b.partition.observation.references.filter(r=>keys.has(refKey(r)))){
   const [left,right]=[a.caseId,b.caseId].sort(),key=canonicalize([left,right,reference]);desired.set(key,{left,right,reference});
  }
 }
 for(const [key,value]of desired){const prior=existing.find(p=>canonicalize([p.left_case_id,p.right_case_id,p.shared_reference])===key);if(prior?.state==='linked')continue;
  const type=value.reference.type==='load'?'shared_load':value.reference.type==='stop'?'shared_stop':'shared_handling_unit';
  await db.query('INSERT INTO record_case_links(id,organization_id,environment,location_id,left_case_id,right_case_id,shared_reference,observation_id,relation_type,state,basis,supersedes_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13)',[newId('case_link'),x.organizationId,x.environment,x.locationId,value.left,value.right,JSON.stringify(value.reference),x.rowId,type,'linked',JSON.stringify({ruleVersion:'packproof.shared-case-reference/v1',basis:'explicit_same_observation_allocations',sourcePolicyVersion:x.casePolicy!.version}),prior?.id??null,clock.now().toISOString()]);
 }
 for(const prior of existing)if(prior.state==='linked'&&!desired.has(canonicalize([prior.left_case_id,prior.right_case_id,prior.shared_reference])))await db.query('INSERT INTO record_case_links(id,organization_id,environment,location_id,left_case_id,right_case_id,shared_reference,observation_id,relation_type,state,basis,supersedes_id,created_at) SELECT $1,organization_id,environment,location_id,left_case_id,right_case_id,shared_reference,observation_id,relation_type,\'removed\',$2::jsonb,id,$3 FROM record_case_links WHERE id=$4',[newId('case_link'),JSON.stringify({ruleVersion:'packproof.shared-case-reference/v1',basis:'association_partition_changed'}),clock.now().toISOString(),prior.id]);
}
async function applyPartitionedObservation(db:Database,clock:Clock,x:CaseWriteContext,n:TypedSourceObservation){
 const split=partitionOperationalObservation(n,x.casePolicy!.sharedEntityTypes);
 if(!split.partitions.length){await db.query("UPDATE record_typed_rows SET status='accepted_unlinked',case_id=NULL,error_code='SOURCE_ORDER_ALLOCATION_REQUIRED' WHERE id=$1",[x.rowId]);return null;}
 const prior=await partitionHeads(db,x.rowId),active=new Set<string>(),linked:Array<{caseId:string;partition:ObservationPartition}>=[];
 let unresolved=split.unassignedAssertions.length>0||split.unassignedRelationships.length>0;
 for(const partition of split.partitions){
  const resolved=await resolvePartition(db,clock,x,partition);if(!resolved){unresolved=true;continue;}
  if(active.has(resolved.caseId)){unresolved=true;continue;} // Two explicit roots need separate cases.
  active.add(resolved.caseId);const head=prior.find(p=>p.case_id===resolved.caseId);
  if(await recordPartition(db,clock,x,resolved.caseId,'linked',partition,resolved.basis,head))await materialize(db,clock,x,partition.observation,resolved.caseId,resolved.basis,{assertionIndexes:partition.assertionIndexes,relationshipIndexes:partition.relationshipIndexes});
  linked.push({caseId:resolved.caseId,partition});
 }
 for(const head of prior.filter(p=>p.state==='linked'&&!active.has(p.case_id))){
  const empty={root:head.normalized.references.find(r=>r.type==='order')!,observation:{...head.normalized,assertions:[],relationships:[]},assertionIndexes:[],relationshipIndexes:[]};
  await recordPartition(db,clock,x,head.case_id,'removed',empty,{ruleVersion:'packproof.case-partition/v1',kind:'association_partition_changed'},head);await bump(db,clock,head.case_id,x.rowId,'association.corrected');
 }
 await updateSharedLinks(db,clock,x,linked);
 const caseIds=[...active].sort(),primary=!unresolved&&caseIds.length===1?caseIds[0]:null;
 await db.query('UPDATE record_typed_rows SET status=$2,case_id=$3,error_code=$4 WHERE id=$1',[x.rowId,unresolved||!caseIds.length?'accepted_unlinked':'accepted_linked',primary,unresolved?'CASE_PARTITION_PENDING':caseIds.length?null:'SOURCE_REFERENCE_UNRESOLVED']);
 return primary;
}

/** Bridge qualified source shipment snapshots through the existing Proof
 * commands. Sparse/fractional/mixed-unit cases remain cases: the legacy
 * transaction contract cannot represent those quantities without invention. */
export async function attachQualifiedShipmentProofs(db:Database,clock:Clock,a:PartnerActor,batchId:string) {
 await db.query('SELECT pg_advisory_xact_lock(1347438158,hashtext($1))',[batchId]);
 const batch=(await db.query<{organization_id:string;environment:string;connection_id:string;location_id:string;operator_membership_id:string;source_profile:string;contract:{completeness:{kind:string}};qualified:boolean}>(`SELECT b.organization_id,b.environment,b.connection_id,b.location_id,b.operator_membership_id,b.source_profile,b.contract,(s.configuration->'completenessPolicy'->>'sourceOwnerQualified')::boolean AS qualified FROM record_typed_batches b JOIN record_source_subscription_revisions s ON s.subscription_id=b.subscription_id AND s.revision=b.configuration_revision WHERE b.id=$1 AND b.organization_id=$2 AND b.environment=$3`,[batchId,a.merchantId,a.environment])).rows[0];
 if(!batch||!['packproof.order-lines/v1','packproof.shipment-handling-units/v1'].includes(batch.source_profile))return;
 await db.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([batch.organization_id,batch.environment,batch.location_id])]);
 const cases=(await db.query<{case_id:string}>(`SELECT DISTINCT c.id case_id FROM record_cases c JOIN record_typed_rows r ON c.id IN ${observationCaseCandidatesSql('r')} AND ${currentCaseObservationSql('r','c.id')} WHERE r.batch_id=$1 AND c.organization_id=$2 AND c.environment=$3 AND c.location_id=$4 AND c.operator_membership_id=$5`,[batchId,a.merchantId,a.environment,batch.location_id,batch.operator_membership_id])).rows;
 for(const {case_id:caseId}of cases){
  const observations=(await db.query<{id:string;batch_id:string;normalized:TypedSourceObservation}>(`SELECT r.id,r.batch_id,${currentCaseObservationProjectionSql('r','$1')} normalized FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE ${currentCaseObservationSql('r','$1')} AND b.connection_id=$2 AND b.organization_id=$3 AND b.environment=$4 AND b.location_id=$5 AND b.operator_membership_id=$6 AND NOT(${caseObservationSupersededSql('r.id','$1')})`,[caseId,batch.connection_id,a.merchantId,a.environment,batch.location_id,batch.operator_membership_id])).rows;
  const descriptions=new Map<string,Set<string>>(),shipments=new Map<string,{ref:TypedSourceReference;lines:Map<string,Map<string,{amount:string;unit:string}>>;rows:Set<string>}>();
  for(const row of observations){const n=row.normalized;
   for(const value of n.assertions)if(value.property==='description'&&typeof value.value==='string'){const key=refKey(value.subjectReference),set=descriptions.get(key)??new Set<string>();set.add(value.value);descriptions.set(key,set);}
   for(const shipment of n.references.filter(r=>r.type==='shipment')){
    const group=shipments.get(refKey(shipment))??{ref:shipment,lines:new Map(),rows:new Set<string>()};
    for(const relation of n.relationships.filter(r=>r.type==='fulfills'&&refKey(r.from)===refKey(shipment)&&r.to.type==='order_line')){
     const key=refKey(relation.to),values=group.lines.get(key)??new Map();
     for(const value of n.assertions.filter(v=>v.property==='allocatedQuantity'&&refKey(v.subjectReference)===key&&typeof v.value==='object'))values.set(canonicalize(value.value),value.value as {amount:string;unit:string});
     group.lines.set(key,values);group.rows.add(row.id);
    }
    shipments.set(refKey(shipment),group);
   }
  }
  for(const group of shipments.values()){
   await reauthorizePartner(db,clock,a,'proofs:write');
   const binding=(await db.query<{proof_id:string}>(`SELECT b.proof_id FROM platform_external_bindings b JOIN platform_proof_ownership o ON o.proof_id=b.proof_id JOIN record_state s ON s.proof_id=b.proof_id WHERE b.merchant_id=$1 AND b.environment=$2 AND b.integration_account_id=$3 AND b.resource_type='SHIPMENT' AND b.external_id=$4 AND s.location_id=$5 AND o.operator_membership_id=$6`,[a.merchantId,a.environment,batch.connection_id,operationalShipmentKey(group.ref,batch.location_id),batch.location_id,batch.operator_membership_id])).rows;
   let proofId=binding.length===1?binding[0].proof_id:null;
   if(binding.length>1)continue;
   if(!proofId){
    // A physical shipment shared by orders cannot be synthesized from one
    // order's allocation subset. Existing qualified whole-shipment bindings
    // can still be members of every authorized case.
    if((await db.query(`SELECT 1 FROM record_case_row_projections p WHERE p.observation_id=ANY($1::text[]) AND p.state='linked' AND NOT EXISTS(SELECT 1 FROM record_case_row_projections successor WHERE successor.supersedes_id=p.id) GROUP BY p.observation_id HAVING COUNT(DISTINCT p.case_id)>1 LIMIT 1`,[[...group.rows]])).rows[0])continue;
    if(!batch.qualified||batch.contract.completeness.kind==='unknown'||(await db.query("SELECT 1 FROM record_typed_rows WHERE batch_id=$1 AND status NOT IN ('accepted_linked','duplicate') LIMIT 1",[batchId])).rows[0])continue;
    if(!group.lines.size||[...group.lines.values()].some(v=>v.size!==1))continue;
    const quantities=[...group.lines.values()].map(v=>[...v.values()][0]);
    if(quantities.some(q=>q.unit!=='each'||!/^\d+$/.test(q.amount)||BigInt(q.amount)<1n))continue;
    const total=quantities.reduce((sum,q)=>sum+BigInt(q.amount),0n);if(total>100000n)continue;
    const shipmentDescriptions=descriptions.get(refKey(group.ref));
    let title:string|null=null;
    if(shipmentDescriptions?.size===1)title=[...shipmentDescriptions][0];
    else {
     const lineTitles=[...group.lines.keys()].sort().map(key=>descriptions.get(key));
     if(lineTitles.some(t=>!t||t.size!==1))continue;
     title=lineTitles.map(t=>[...t!][0]).join('; ');
    }
    if(!title||title.length>200)continue;
    const externalId=`typed-shipment:${sha256Hex(canonicalize([batch.connection_id,batch.location_id,group.ref.namespace,group.ref.externalId]))}`;
    const created=await importPartnerOrder(db,clock,a,{integrationAccountId:batch.connection_id,externalId,operatorMembershipId:batch.operator_membership_id,transaction:{itemTitle:title,quantity:Number(total)}});proofId=created.proofId;
    const now=clock.now().toISOString(),hash=sha256Hex(canonicalize({batchId,rows:[...group.rows].sort(),title,quantity:String(total)}));
    await db.query("INSERT INTO platform_external_bindings(merchant_id,environment,integration_account_id,resource_type,external_id,proof_id,snapshot_sha256,created_at) VALUES($1,$2,$3,'SHIPMENT',$4,$5,$6,$7)",[a.merchantId,a.environment,batch.connection_id,operationalShipmentKey(group.ref,batch.location_id),proofId,hash,now]);
    await db.query('INSERT INTO record_state(proof_id,organization_id,environment,title,reference,location_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(proof_id) DO NOTHING',[proofId,a.merchantId,a.environment,title,group.ref.externalId,batch.location_id,now]);
    await appendAudit(db,{proofId,actorUserId:a.actorUserId,eventType:'TYPED_SOURCE_SHIPMENT_IMPORTED',eventData:{batchId,caseId,sourceRows:[...group.rows].sort(),sourceNamespace:group.ref.namespace,shipmentReference:group.ref.externalId,quantityBasis:'sum_of_explicit_each_allocations',descriptionBasis:shipmentDescriptions?.size===1?'source_shipment_description':'source_line_descriptions'},at:clock.now()});
   }
   await authorizePartnerProof(db,clock,a,proofId,'proofs:read');
   for(const sourceRowId of group.rows)await db.query('INSERT INTO record_case_members(case_id,proof_id,organization_id,environment,source_row_id,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[caseId,proofId,a.merchantId,a.environment,sourceRowId,clock.now().toISOString()]);
  }
 }
}

/** Explicit human crosswalk. A revision may correct a previous decision;
 * source receipts and assertion history remain append-only. */
export async function approveCaseCrosswalk(db:Database,clock:Clock,w:RecordWorkspace,input:unknown,key:unknown) {
 requireReconstructionFeature('reconstruction');
 if(w.partner)throw new DomainError('HUMAN_APPROVAL_REQUIRED','An authorized person must approve identity crosswalks',403);
 const b=strictBody(input,['caseId','locationId','namespace','type','externalId','parentExternalId','ruleVersion','reason','supersedesId']);
 const caseId=textField(b.caseId,'caseId'),namespace=textField(b.namespace,'namespace',100),externalId=textField(b.externalId,'externalId',200),rule=textField(b.ruleVersion,'ruleVersion',100),reason=textField(b.reason,'reason',1000);
 if(!SOURCE_ENTITY_TYPES.includes(b.type as never)||externalId!==b.externalId||namespace!==b.namespace)throw new DomainError('INVALID_SOURCE_REFERENCE','Use exact qualified source identifiers',400);
 const parent=b.type==='order_line'?textField(b.parentExternalId,'parentExternalId',200):'';
 if(b.type!=='order_line'&&b.parentExternalId!=null)throw new DomainError('INVALID_SOURCE_REFERENCE','Only an order line has a parent order identity',400);
 const current=await requireCaseWorkspace(db,clock,w,true);if(!['OWNER','ADMIN'].includes(current.role))throw new DomainError('CASE_APPROVAL_DENIED','A workspace administrator must approve identity crosswalks',403);
 const c=await requireCaseAccess(db,clock,current,caseId,true);if(b.locationId!==c.location_id)throw unavailable();
 const result=await idempotent(db,clock,current.tenantId,`case-crosswalk:${current.membershipId}`,key,input,async tx=>{
  const authorized=await requireCaseWorkspace(tx,clock,current,true);if(!['OWNER','ADMIN'].includes(authorized.role))throw new DomainError('CASE_APPROVAL_DENIED','A current workspace administrator must approve identity crosswalks',403);
  await requireCaseAccess(tx,clock,authorized,caseId,true);
  await tx.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([current.organizationId,current.environment,c.location_id])]);
  const old=(await tx.query<{id:string;case_id:string}>(`SELECT x.id,x.case_id FROM record_case_crosswalks x WHERE organization_id=$1 AND environment=$2 AND location_id=$3 AND namespace=$4 AND entity_type=$5 AND external_id=$6 AND parent_external_id=$7 AND NOT EXISTS(SELECT 1 FROM record_case_crosswalks newer WHERE newer.supersedes_id=x.id)`,[current.organizationId,current.environment,c.location_id,namespace,b.type,externalId,parent])).rows[0];
  if(old){await requireCaseAccess(tx,clock,current,old.case_id,true);if(old.case_id===caseId&&b.supersedesId==null)return {id:old.id,caseId};if(b.supersedesId!==old.id)throw new DomainError('CASE_CROSSWALK_CHANGED','Review and explicitly supersede the current crosswalk before changing it',409);}
  else if(b.supersedesId!=null)throw new DomainError('CASE_CROSSWALK_CHANGED','The specified prior crosswalk is unavailable',409);
  const id=newId('case_crosswalk');
  await tx.query('INSERT INTO record_case_crosswalks(id,organization_id,environment,location_id,namespace,entity_type,external_id,case_id,rule_version,reason,approved_by,supersedes_id,created_at,parent_external_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[id,current.organizationId,current.environment,c.location_id,namespace,b.type,externalId,caseId,rule,reason,current.userId,old?.id??null,clock.now().toISOString(),parent]);
  return {id,caseId};
 });
 const after=await requireCaseWorkspace(db,clock,current,true);if(!['OWNER','ADMIN'].includes(after.role))throw new DomainError('CASE_APPROVAL_DENIED','A current workspace administrator must review identity crosswalks',403);
 await requireCaseAccess(db,clock,after,caseId,true);return {...result.value,replayed:result.replayed};
}

export interface CaseIdentityAliasView {id:string;revisionHash:string;left:{caseId:string;reference:TypedSourceReference};right:{caseId:string;reference:TypedSourceReference};cardinality:'one_to_one';effectiveFrom:string|null;effectiveUntil:string|null;ruleVersion:string;reason:string;approvedBy:string;approvedAt:string;}
export interface CaseIdentityRuleView {id:string;revisionHash:string;locationId:string;leftNamespace:string;rightNamespace:string;type:TypedSourceReference['type'];mode:'exact_external_and_parent';cardinality:'one_to_one';effectiveFrom:string|null;effectiveUntil:string|null;ruleVersion:string;reason:string;approvedBy:string;approvedAt:string;}
interface IdentityAliasRow {id:string;left_case_id:string;right_case_id:string;left_reference:TypedSourceReference;right_reference:TypedSourceReference;cardinality:'one_to_one';effective_from:string|Date|null;effective_until:string|Date|null;rule_version:string;reason:string;approved_by:string;created_at:string|Date;}
interface IdentityRuleRow {id:string;location_id:string;left_namespace:string;right_namespace:string;entity_type:TypedSourceReference['type'];mode:'exact_external_and_parent';cardinality:'one_to_one';effective_from:string|Date|null;effective_until:string|Date|null;rule_version:string;reason:string;approved_by:string;created_at:string|Date;}
const identityTime=(v:string|Date|null)=>v===null?null:new Date(v).toISOString();
function aliasView(r:IdentityAliasRow):CaseIdentityAliasView {const value={id:r.id,left:{caseId:r.left_case_id,reference:r.left_reference},right:{caseId:r.right_case_id,reference:r.right_reference},cardinality:r.cardinality,effectiveFrom:identityTime(r.effective_from),effectiveUntil:identityTime(r.effective_until),ruleVersion:r.rule_version,reason:r.reason,approvedBy:r.approved_by,approvedAt:new Date(r.created_at).toISOString()};return {...value,revisionHash:sha256Hex(canonicalize(value))};}
function identityRuleView(r:IdentityRuleRow):CaseIdentityRuleView {const value={id:r.id,locationId:r.location_id,leftNamespace:r.left_namespace,rightNamespace:r.right_namespace,type:r.entity_type,mode:r.mode,cardinality:r.cardinality,effectiveFrom:identityTime(r.effective_from),effectiveUntil:identityTime(r.effective_until),ruleVersion:r.rule_version,reason:r.reason,approvedBy:r.approved_by,approvedAt:new Date(r.created_at).toISOString()};return {...value,revisionHash:sha256Hex(canonicalize(value))};}
function exactReference(input:unknown):TypedSourceReference {
 const b=strictBody(input,['namespace','type','externalId','parentExternalId']),namespace=textField(b.namespace,'namespace',100),externalId=textField(b.externalId,'externalId',200);
 if(!SOURCE_ENTITY_TYPES.includes(b.type as never)||namespace!==b.namespace||externalId!==b.externalId)throw new DomainError('INVALID_SOURCE_REFERENCE','Use exact qualified source identifiers',400);
 const parent=b.type==='order_line'?textField(b.parentExternalId,'parentExternalId',200):null;
 if(b.type!=='order_line'&&b.parentExternalId!=null)throw new DomainError('INVALID_SOURCE_REFERENCE','Only an order line has a parent order identity',400);
 return {namespace,type:b.type as TypedSourceReference['type'],externalId,...(parent?{parentExternalId:parent}:{})};
}
function identityInterval(b:Record<string,unknown>) {
 const parse=(v:unknown)=>{if(v==null)return null;if(typeof v!=='string'||explicitInstant(v)===null)throw new DomainError('INVALID_IDENTITY_EFFECTIVE_TIME','Use an explicit ISO effective timestamp or an explicitly timeless mapping',400);return new Date(v).toISOString();};
 const from=parse(b.effectiveFrom),until=parse(b.effectiveUntil);if(from&&until&&from>=until)throw new DomainError('INVALID_IDENTITY_EFFECTIVE_TIME','The effective interval must end after it starts',400);return {from,until};
}
async function identityAdmin(db:Database,clock:Clock,w:RecordWorkspace) {requireReconstructionFeature('crossCase');if(w.partner)throw new DomainError('HUMAN_APPROVAL_REQUIRED','An authorized person must approve source identity mappings',403);const current=await requireCaseWorkspace(db,clock,w,true);if(!['OWNER','ADMIN'].includes(current.role))throw new DomainError('CASE_APPROVAL_DENIED','A workspace administrator must approve source identity mappings',403);return current;}
async function requireEntityReference(db:Database,caseId:string,ref:TypedSourceReference){if(!(await db.query(`SELECT 1 FROM record_case_entities e WHERE e.case_id=$1 AND e.namespace=$2 AND e.entity_type=$3 AND e.external_id=$4 AND e.parent_external_id=$5 AND ${currentCaseEntitySql('e')}`,[caseId,ref.namespace,ref.type,ref.externalId,ref.parentExternalId??''])).rows[0])throw new DomainError('CASE_IDENTITY_NOT_FOUND','Select an existing exact source identity in the permitted case',404);}
async function assertIdentityEndpointsCurrent(db:Database,clock:Clock,w:RecordWorkspace,caseIds:string[],locationId:string) {
 const current=await requireCaseWorkspace(db,clock,w);await requireRecordLocation(db,current,locationId);const ids=[...new Set(caseIds)];if(!ids.length)return;
 const scope=caseScopeSql(current),allowed=(await db.query<{id:string}>(`SELECT c.id FROM record_cases c WHERE ${scope.sql} AND c.id=ANY($6::text[])`,[...scope.params,ids])).rows;
 if(allowed.length!==ids.length)throw new DomainError('CASE_PROJECTION_CHANGED','Case endpoint authorization changed during identity mapping review',409);
}
/** Every endpoint is scoped before mappings are selected. Hidden neighbors do
 * not contribute identifiers, provenance, or counts to this response. */
export async function readCaseIdentityMappingsForProjection(db:Database,clock:Clock,w:RecordWorkspace,caseId:string) {
 const current=await requireCaseWorkspace(db,clock,w),c=await requireCaseAccess(db,clock,current,caseId),scope=caseScopeSql(current,'l'),right=caseScopeSql(current,'r');
 const aliases=(await db.query<IdentityAliasRow>(`SELECT a.* FROM record_case_entity_aliases a JOIN record_cases l ON l.id=a.left_case_id JOIN record_cases r ON r.id=a.right_case_id WHERE ${scope.sql} AND ${right.sql} AND a.location_id=$6 AND (a.left_case_id=$7 OR a.right_case_id=$7) AND NOT EXISTS(SELECT 1 FROM record_case_entity_aliases successor WHERE successor.supersedes_id=a.id) ORDER BY a.id LIMIT 501`,[...scope.params,c.location_id,caseId])).rows;
 const rules=(await db.query<IdentityRuleRow>(`SELECT r.* FROM record_case_identity_rules r WHERE r.organization_id=$1 AND r.environment=$2 AND r.location_id=$3 AND NOT EXISTS(SELECT 1 FROM record_case_identity_rules successor WHERE successor.supersedes_id=r.id) ORDER BY r.id LIMIT 501`,[current.organizationId,current.environment,c.location_id])).rows;
 if(aliases.length>500||rules.length>500)throw new DomainError('CASE_IDENTITY_MAPPING_LIMIT','Narrow the approved identity mapping set before reconstructing this case',409);
 await assertIdentityEndpointsCurrent(db,clock,current,[caseId,...aliases.flatMap(a=>[a.left_case_id,a.right_case_id])],c.location_id);return {aliases:aliases.map(aliasView),rules:rules.map(identityRuleView)};
}
export async function listCaseIdentityMappings(db:Database,clock:Clock,w:RecordWorkspace,input:{locationId:string;after?:string;limit?:number}) {
 const current=await requireCaseWorkspace(db,clock,w);await requireRecordLocation(db,current,input.locationId);
 const scope=caseScopeSql(current,'l'),right=caseScopeSql(current,'r'),limit=Math.max(1,Math.min(input.limit??50,100)),after=input.after??'';
 const aliases=(await db.query<IdentityAliasRow>(`SELECT a.* FROM record_case_entity_aliases a JOIN record_cases l ON l.id=a.left_case_id JOIN record_cases r ON r.id=a.right_case_id WHERE ${scope.sql} AND ${right.sql} AND a.location_id=$6 AND a.id>$7 AND NOT EXISTS(SELECT 1 FROM record_case_entity_aliases successor WHERE successor.supersedes_id=a.id) ORDER BY a.id LIMIT $8`,[...scope.params,input.locationId,after,limit+1])).rows;
 const rules=(await db.query<IdentityRuleRow>(`SELECT r.* FROM record_case_identity_rules r WHERE r.organization_id=$1 AND r.environment=$2 AND r.location_id=$3 AND r.id>$4 AND NOT EXISTS(SELECT 1 FROM record_case_identity_rules successor WHERE successor.supersedes_id=r.id) ORDER BY r.id LIMIT $5`,[current.organizationId,current.environment,input.locationId,after,limit+1])).rows;
 const ids=[...aliases.map(a=>a.id),...rules.map(a=>a.id)].sort(),page=new Set(ids.slice(0,limit));
 await assertIdentityEndpointsCurrent(db,clock,current,aliases.flatMap(a=>[a.left_case_id,a.right_case_id]),input.locationId);return {aliases:aliases.filter(a=>page.has(a.id)).map(aliasView),rules:rules.filter(a=>page.has(a.id)).map(identityRuleView),nextAfter:ids.length>limit?ids[limit-1]:null};
}
export async function readCaseEntityChoices(db:Database,clock:Clock,w:RecordWorkspace,caseId:string,input:{after?:string;limit?:number}={}) {
 await requireCaseAccess(db,clock,w,caseId);const limit=Math.max(1,Math.min(input.limit??100,250)),rows=(await db.query<{id:string;namespace:string;entity_type:TypedSourceReference['type'];external_id:string;parent_external_id:string}>(`SELECT e.id,e.namespace,e.entity_type,e.external_id,e.parent_external_id FROM record_case_entities e WHERE e.case_id=$1 AND e.id>$2 AND ${currentCaseEntitySql('e')} ORDER BY e.id LIMIT $3`,[caseId,input.after??'',limit+1])).rows;
 await requireCaseAccess(db,clock,w,caseId);return {caseId,entities:rows.slice(0,limit).map(r=>({id:r.id,reference:{namespace:r.namespace,type:r.entity_type,externalId:r.external_id,...(r.parent_external_id?{parentExternalId:r.parent_external_id}:{})},display:`${r.entity_type}: ${r.external_id}${r.parent_external_id?` (order ${r.parent_external_id})`:''}`,sourceNamespace:r.namespace})),nextAfter:rows.length>limit?rows[limit-1].id:null};
}
export async function approveCaseEntityAlias(db:Database,clock:Clock,w:RecordWorkspace,input:unknown,key:unknown) {
 const b=strictBody(input,['left','right','cardinality','effectiveFrom','effectiveUntil','ruleVersion','reason','supersedesId']),left=strictBody(b.left,['caseId','reference']),right=strictBody(b.right,['caseId','reference']);
 const l={caseId:textField(left.caseId,'caseId'),reference:exactReference(left.reference)},r={caseId:textField(right.caseId,'caseId'),reference:exactReference(right.reference)},interval=identityInterval(b),rule=textField(b.ruleVersion,'ruleVersion',100),reason=textField(b.reason,'reason',1000);
 if(b.cardinality!=='one_to_one'||l.reference.type!==r.reference.type||refKey(l.reference)===refKey(r.reference))throw new DomainError('INVALID_IDENTITY_ALIAS','Approve two distinct references of the same entity type with one-to-one cardinality',400);
 const current=await identityAdmin(db,clock,w);
 await requireCaseAccess(db,clock,current,l.caseId,true);await requireCaseAccess(db,clock,current,r.caseId,true);await requireEntityReference(db,l.caseId,l.reference);await requireEntityReference(db,r.caseId,r.reference);
 const result=await idempotent(db,clock,current.tenantId,`case-entity-alias:${current.membershipId}`,key,input,async tx=>{
  await identityAdmin(tx,clock,current);const lc=await requireCaseAccess(tx,clock,current,l.caseId,true),rc=await requireCaseAccess(tx,clock,current,r.caseId,true);if(lc.location_id!==rc.location_id||lc.operator_membership_id!==rc.operator_membership_id)throw new DomainError('IDENTITY_ALIAS_SCOPE_DENIED','Both identity endpoints must have the same site and approved operator',403);
  await requireEntityReference(tx,l.caseId,l.reference);await requireEntityReference(tx,r.caseId,r.reference);await tx.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([current.organizationId,current.environment,lc.location_id])]);
  const old=b.supersedesId==null?undefined:(await tx.query<IdentityAliasRow>(`SELECT a.* FROM record_case_entity_aliases a WHERE a.id=$1 AND a.organization_id=$2 AND a.environment=$3 AND a.location_id=$4 AND NOT EXISTS(SELECT 1 FROM record_case_entity_aliases successor WHERE successor.supersedes_id=a.id)`,[b.supersedesId,current.organizationId,current.environment,lc.location_id])).rows[0];
  if(b.supersedesId!=null&&!old)throw new DomainError('CASE_IDENTITY_MAPPING_CHANGED','Review the current identity mapping before superseding it',409);
  if(old){await requireCaseAccess(tx,clock,current,old.left_case_id,true);await requireCaseAccess(tx,clock,current,old.right_case_id,true);if(!((old.left_case_id===l.caseId&&refKey(old.left_reference)===refKey(l.reference))||(old.right_case_id===l.caseId&&refKey(old.right_reference)===refKey(l.reference))))throw new DomainError('CASE_IDENTITY_MAPPING_CHANGED','A correction must retain its explicitly selected source identity',409);}
  const conflicts=(await tx.query<{id:string}>(`SELECT a.id FROM record_case_entity_aliases a WHERE a.organization_id=$1 AND a.environment=$2 AND a.location_id=$3 AND ($4::text IS NULL OR a.id<>$4) AND NOT EXISTS(SELECT 1 FROM record_case_entity_aliases successor WHERE successor.supersedes_id=a.id) AND (a.effective_until IS NULL OR $5::timestamptz IS NULL OR a.effective_until>$5) AND ($6::timestamptz IS NULL OR a.effective_from IS NULL OR a.effective_from<$6) AND ((a.left_case_id=$7 AND a.left_reference=$8::jsonb) OR (a.right_case_id=$7 AND a.right_reference=$8::jsonb) OR (a.left_case_id=$9 AND a.left_reference=$10::jsonb) OR (a.right_case_id=$9 AND a.right_reference=$10::jsonb)) LIMIT 1`,[current.organizationId,current.environment,lc.location_id,old?.id??null,interval.from,interval.until,l.caseId,JSON.stringify(l.reference),r.caseId,JSON.stringify(r.reference)])).rows;
  if(conflicts.length)throw new DomainError('IDENTITY_ALIAS_CARDINALITY_CONFLICT','Review and explicitly supersede the existing one-to-one alias for this effective interval',409);
  const id=newId('case_alias');await tx.query(`INSERT INTO record_case_entity_aliases(id,organization_id,environment,location_id,left_case_id,right_case_id,left_reference,right_reference,cardinality,effective_from,effective_until,rule_version,reason,approved_by,supersedes_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'one_to_one',$9,$10,$11,$12,$13,$14,$15)`,[id,current.organizationId,current.environment,lc.location_id,l.caseId,r.caseId,JSON.stringify(l.reference),JSON.stringify(r.reference),interval.from,interval.until,rule,reason,current.userId,old?.id??null,clock.now().toISOString()]);
  await bump(tx,clock,l.caseId,null,'case.updated');if(l.caseId!==r.caseId)await bump(tx,clock,r.caseId,null,'case.updated');return {id};
 });const after=await identityAdmin(db,clock,current);await requireCaseAccess(db,clock,after,l.caseId,true);await requireCaseAccess(db,clock,after,r.caseId,true);await requireEntityReference(db,l.caseId,l.reference);await requireEntityReference(db,r.caseId,r.reference);return {...result.value,replayed:result.replayed};
}
export async function approveCaseIdentityRule(db:Database,clock:Clock,w:RecordWorkspace,input:unknown,key:unknown) {
 const b=strictBody(input,['locationId','leftNamespace','rightNamespace','type','mode','cardinality','effectiveFrom','effectiveUntil','ruleVersion','reason','supersedesId']),locationId=textField(b.locationId,'locationId'),names=[textField(b.leftNamespace,'leftNamespace',100),textField(b.rightNamespace,'rightNamespace',100)].sort(),interval=identityInterval(b),rule=textField(b.ruleVersion,'ruleVersion',100),reason=textField(b.reason,'reason',1000);
 if(names[0]===names[1]||b.leftNamespace!==String(b.leftNamespace).trim()||b.rightNamespace!==String(b.rightNamespace).trim()||!SOURCE_ENTITY_TYPES.includes(b.type as never)||b.mode!=='exact_external_and_parent'||b.cardinality!=='one_to_one')throw new DomainError('INVALID_IDENTITY_RULE','Approve exact namespace, entity type, parent identity and one-to-one cardinality',400);
 const current=await identityAdmin(db,clock,w);await requireRecordLocation(db,current,locationId);
 const result=await idempotent(db,clock,current.tenantId,`case-identity-rule:${current.membershipId}`,key,input,async tx=>{
  await identityAdmin(tx,clock,current);await requireRecordLocation(tx,current,locationId);await tx.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([current.organizationId,current.environment,locationId])]);
  const old=b.supersedesId==null?undefined:(await tx.query<IdentityRuleRow>(`SELECT r.* FROM record_case_identity_rules r WHERE r.id=$1 AND r.organization_id=$2 AND r.environment=$3 AND r.location_id=$4 AND r.left_namespace=$5 AND r.right_namespace=$6 AND r.entity_type=$7 AND NOT EXISTS(SELECT 1 FROM record_case_identity_rules successor WHERE successor.supersedes_id=r.id)`,[b.supersedesId,current.organizationId,current.environment,locationId,...names,b.type])).rows[0];
  if(b.supersedesId!=null&&!old)throw new DomainError('CASE_IDENTITY_MAPPING_CHANGED','Review the current namespace rule before superseding it',409);
  if((await tx.query(`SELECT 1 FROM record_case_identity_rules r WHERE r.organization_id=$1 AND r.environment=$2 AND r.location_id=$3 AND r.left_namespace=$4 AND r.right_namespace=$5 AND r.entity_type=$6 AND ($7::text IS NULL OR r.id<>$7) AND NOT EXISTS(SELECT 1 FROM record_case_identity_rules successor WHERE successor.supersedes_id=r.id) AND (r.effective_until IS NULL OR $8::timestamptz IS NULL OR r.effective_until>$8) AND ($9::timestamptz IS NULL OR r.effective_from IS NULL OR r.effective_from<$9) LIMIT 1`,[current.organizationId,current.environment,locationId,...names,b.type,old?.id??null,interval.from,interval.until])).rows[0])throw new DomainError('IDENTITY_RULE_CARDINALITY_CONFLICT','Review and explicitly supersede the existing namespace rule for this effective interval',409);
  const id=newId('case_identity_rule');await tx.query(`INSERT INTO record_case_identity_rules(id,organization_id,environment,location_id,left_namespace,right_namespace,entity_type,mode,cardinality,effective_from,effective_until,rule_version,reason,approved_by,supersedes_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'exact_external_and_parent','one_to_one',$8,$9,$10,$11,$12,$13,$14)`,[id,current.organizationId,current.environment,locationId,...names,b.type,interval.from,interval.until,rule,reason,current.userId,old?.id??null,clock.now().toISOString()]);return {id};
 });const after=await identityAdmin(db,clock,current);await requireRecordLocation(db,after,locationId);return {...result.value,replayed:result.replayed};
}
/** Current explicit case attachments, visible only through the currently
 * authorized destination case. Prior decisions remain immutable history. */
export async function readCaseCrosswalks(db:Database,clock:Clock,w:RecordWorkspace,caseId:string) {
 const current=await requireCaseWorkspace(db,clock,w);await requireCaseAccess(db,clock,current,caseId);
 const rows=(await db.query<{id:string;case_id:string;namespace:string;entity_type:TypedSourceReference['type'];external_id:string;parent_external_id:string;rule_version:string;reason:string;approved_by:string;created_at:string|Date}>(`SELECT m.* FROM record_case_crosswalks m WHERE m.case_id=$1 AND m.organization_id=$2 AND m.environment=$3 AND NOT EXISTS(SELECT 1 FROM record_case_crosswalks successor WHERE successor.supersedes_id=m.id) ORDER BY m.id LIMIT 501`,[caseId,current.organizationId,current.environment])).rows;
 if(rows.length>500)throw new DomainError('CASE_CROSSWALK_LIMIT','Narrow the case identity attachments before reviewing this mapping',409);
 await requireCaseAccess(db,clock,current,caseId);return {caseId,crosswalks:rows.map(r=>({id:r.id,caseId:r.case_id,reference:{namespace:r.namespace,type:r.entity_type,externalId:r.external_id,...(r.parent_external_id?{parentExternalId:r.parent_external_id}:{})},ruleVersion:r.rule_version,reason:r.reason,approvedBy:r.approved_by,approvedAt:new Date(r.created_at).toISOString()}))};
}
