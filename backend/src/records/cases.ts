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
import {requireReconstructionFeature} from './reconstruction-features.js';
import {importPartnerOrder} from '../platform/partner-proofs.js';
import {appendAudit} from '../domain/audit.js';

export interface OperationalCaseRow {
 id:string;organization_id:string;environment:'sandbox'|'live';location_id:string;location_key:string;
 operator_membership_id:string;root_namespace:string;root_type:'order'|'shipment'|'return';root_external_id:string;
 revision:number|string;created_at:string|Date;updated_at:string|Date;
}
const unavailable=()=>new DomainError('CASE_NOT_FOUND','Operational case not found',404);
const refKey=(r:TypedSourceReference)=>canonicalize([r.namespace,r.type,r.externalId,(r as TypedSourceReference&{parentExternalId?:string}).parentExternalId??'']);
const operationalShipmentKey=(r:TypedSourceReference,locationId:string)=>`typed:v1:${sha256Hex(canonicalize([locationId,r.namespace,r.type,r.externalId]))}`;

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

interface CaseWriteContext {organizationId:string;environment:'sandbox'|'live';locationId:string;operatorMembershipId:string;actor:PartnerActor;batchId:string;rowId:string;rowNumber:number;receivedAt:string;source:TypedSourceBatch;}
async function bump(db:Database,clock:Clock,id:string,rowId:string,event='case.updated') {
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
async function materialize(db:Database,clock:Clock,x:CaseWriteContext,n:TypedSourceObservation,caseId:string,basis:unknown) {
 const prior=(await db.query<{id:string;case_id:string}>(`SELECT d.id,d.case_id FROM record_case_association_decisions d WHERE d.observation_id=$1 AND NOT EXISTS(SELECT 1 FROM record_case_association_decisions newer WHERE newer.supersedes_id=d.id)`,[x.rowId])).rows[0];
 const state=(await db.query<{status:string;case_id:string}>('SELECT status,case_id FROM record_typed_rows WHERE id=$1',[x.rowId])).rows[0];
 if(prior?.case_id===caseId&&state.status==='accepted_linked'&&state.case_id===caseId)return caseId;
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
  const id=`assertion_${sha256Hex(canonicalize([x.rowId,caseId,i]))}`;
  await db.query(`INSERT INTO record_case_assertions(id,case_id,entity_id,batch_id,row_number,observation_id,connection_id,source_namespace,property,value,unit,source_locator,mapping_version,source_revision,occurred_at,source_as_of,time_quality,origin,received_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb,$19) ON CONFLICT(id) DO NOTHING`,[id,caseId,entityIds.get(refKey(a.subjectReference)),x.batchId,x.rowNumber,x.rowId,x.source.connectionId,x.source.sourceNamespace,a.property,JSON.stringify(a.value),typeof a.value==='object'?a.value.unit:null,JSON.stringify(a.sourceLocator),x.source.mappingVersion,n.sourceRevision,n.occurredAt,n.sourceAsOf,n.timeQuality,JSON.stringify({originSystem:n.originSystem,copiedFromSource:n.copiedFromSource}),x.receivedAt]);
 }
 for(const [i,r]of (n.observationKind==='tombstone'?[]:n.relationships).entries())await db.query(`INSERT INTO record_case_relations(id,case_id,from_entity_id,to_entity_id,relation_type,quantity,assertion_row_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(id) DO NOTHING`,[`relation_${sha256Hex(canonicalize([x.rowId,caseId,i]))}`,caseId,entityIds.get(refKey(r.from)),entityIds.get(refKey(r.to)),r.type,JSON.stringify(r.quantity),x.rowId,x.receivedAt]);
 if(!prior||prior.case_id!==caseId)await db.query('INSERT INTO record_case_association_decisions(id,observation_id,case_id,supersedes_id,basis,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[newId('case_decision'),x.rowId,caseId,prior?.id??null,JSON.stringify(basis),x.actor.actorUserId,clock.now().toISOString()]);
 await db.query("UPDATE record_typed_rows SET status='accepted_linked',case_id=$2,error_code=NULL WHERE id=$1",[x.rowId,caseId]);
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
 await db.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([x.organizationId,x.environment,x.locationId])]);
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

/** Bridge qualified source shipment snapshots through the existing Proof
 * commands. Sparse/fractional/mixed-unit cases remain cases: the legacy
 * transaction contract cannot represent those quantities without invention. */
export async function attachQualifiedShipmentProofs(db:Database,clock:Clock,a:PartnerActor,batchId:string) {
 const batch=(await db.query<{organization_id:string;environment:string;connection_id:string;location_id:string;operator_membership_id:string;source_profile:string;contract:{completeness:{kind:string}};qualified:boolean}>(`SELECT b.organization_id,b.environment,b.connection_id,b.location_id,b.operator_membership_id,b.source_profile,b.contract,(s.configuration->'completenessPolicy'->>'sourceOwnerQualified')::boolean AS qualified FROM record_typed_batches b JOIN record_source_subscription_revisions s ON s.subscription_id=b.subscription_id AND s.revision=b.configuration_revision WHERE b.id=$1 AND b.organization_id=$2 AND b.environment=$3`,[batchId,a.merchantId,a.environment])).rows[0];
 if(!batch||!['packproof.order-lines/v1','packproof.shipment-handling-units/v1'].includes(batch.source_profile))return;
 const cases=(await db.query<{case_id:string}>('SELECT DISTINCT case_id FROM record_typed_rows WHERE batch_id=$1 AND status=\'accepted_linked\' AND case_id IS NOT NULL',[batchId])).rows;
 for(const {case_id:caseId}of cases){
  const observations=(await db.query<{id:string;normalized:TypedSourceObservation}>(`SELECT r.id,r.normalized FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE r.case_id=$1 AND r.status='accepted_linked' AND b.connection_id=$2 AND b.organization_id=$3 AND b.environment=$4 AND b.location_id=$5 AND b.operator_membership_id=$6 AND NOT EXISTS(SELECT 1 FROM record_typed_rows newer WHERE newer.supersedes_id=r.id AND newer.status='accepted_linked')`,[caseId,batch.connection_id,a.merchantId,a.environment,batch.location_id,batch.operator_membership_id])).rows;
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
  await requireCaseAccess(tx,clock,current,caseId,true);
  await tx.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([current.organizationId,current.environment,c.location_id])]);
  const old=(await tx.query<{id:string;case_id:string}>(`SELECT x.id,x.case_id FROM record_case_crosswalks x WHERE organization_id=$1 AND environment=$2 AND location_id=$3 AND namespace=$4 AND entity_type=$5 AND external_id=$6 AND parent_external_id=$7 AND NOT EXISTS(SELECT 1 FROM record_case_crosswalks newer WHERE newer.supersedes_id=x.id)`,[current.organizationId,current.environment,c.location_id,namespace,b.type,externalId,parent])).rows[0];
  if(old){await requireCaseAccess(tx,clock,current,old.case_id,true);if(old.case_id===caseId&&b.supersedesId==null)return {id:old.id,caseId};if(b.supersedesId!==old.id)throw new DomainError('CASE_CROSSWALK_CHANGED','Review and explicitly supersede the current crosswalk before changing it',409);}
  else if(b.supersedesId!=null)throw new DomainError('CASE_CROSSWALK_CHANGED','The specified prior crosswalk is unavailable',409);
  const id=newId('case_crosswalk');
  await tx.query('INSERT INTO record_case_crosswalks(id,organization_id,environment,location_id,namespace,entity_type,external_id,case_id,rule_version,reason,approved_by,supersedes_id,created_at,parent_external_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[id,current.organizationId,current.environment,c.location_id,namespace,b.type,externalId,caseId,rule,reason,current.userId,old?.id??null,clock.now().toISOString(),parent]);
  return {id,caseId};
 });
 await requireCaseAccess(db,clock,current,caseId,true);return {...result.value,replayed:result.replayed};
}
