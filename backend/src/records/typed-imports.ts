import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {idempotent} from '../platform/idempotency.js';
import {reauthorizePartner,auditOrganization,strictBody,type PartnerActor} from '../platform/organizations.js';
import {parseTypedSourceBatch,type TypedSourceBatch,type TypedSourceObservation,type TypedSourceRow} from './source-contracts.js';
import {applyOperationalObservation,attachQualifiedShipmentProofs} from './cases.js';
import {requireTypedSourceAuthority} from './source-subscriptions.js';
import {requireReconstructionFeature,reconstructionFeatureEnabled} from './reconstruction-features.js';

export type TypedImportDeps=Pick<AppDependencies,'db'|'clock'|'objectStore'|'devAuth'>;
type Outcome='processing'|'accepted_linked'|'accepted_unlinked'|'duplicate'|'conflict'|'quarantined'|'rejected';
export interface TypedBatchRow {
 id:string;organization_id:string;environment:'sandbox'|'live';connection_id:string;location_id:string;subscription_id:string;
 configuration_revision:string|number;grant_revision:string|number;principal_id:string;credential_id:string;actor_context:PartnerActor;operator_membership_id:string;
 source_profile:string;source_namespace:string;mapping_version:string;preview_version:string;source_control_revision:string|number;
 original_name:string;original_media_type:string;original_object_key:string;original_version_id:string;original_sha256:string;original_byte_size:number;
 contract:Omit<TypedSourceBatch,'rows'>;row_count:number;state:'previewed'|'queued'|'running'|'succeeded'|'partially_succeeded'|'blocked_policy'|'failed';
 import_valid_rows:boolean;replay_requested:boolean;received_at:string|Date;updated_at:string|Date;lease_token:string|null;lease_expires_at:string|Date|null;attempts:number;next_attempt_at:string|Date;error_code:string|null;
}
interface Item {id:string;batch_id:string;row_number:number;source_event_id:string|null;source_revision:string|null;payload_sha256:string|null;source_values:unknown;normalized:TypedSourceObservation|null;errors:string[];status:Outcome;case_id:string|null;duplicate_of:string|null;supersedes_id:string|null;error_code:string|null;history_eligibility:'within_bounds'|'unknown'|'out_of_bounds';received_at:string|Date;}
const iso=(v:string|Date)=>new Date(v).toISOString();
const fail=(code:string,message:string,status=409):never=>{throw new DomainError(code,message,status);};
const authorityInput=(b:Omit<TypedSourceBatch,'rows'>)=>({subscriptionId:b.subscriptionId,configurationRevision:b.configurationRevision,grantRevision:(b as typeof b&{grantRevision:number}).grantRevision,connectionId:b.connectionId,locationId:b.locationId,sourceProfile:b.sourceProfile,mappingVersion:b.mappingVersion,sourceNamespace:b.sourceNamespace,mapping:b.mapping,constants:b.constants,wholeFileConsent:b.wholeFileConsent,originalSha256:b.original.sha256,originalName:b.original.name,originalMediaType:b.original.mediaType,headers:b.headers});
async function batch(db:Database,id:string,lock=false) {const row=(await db.query<TypedBatchRow>(`SELECT * FROM record_typed_batches WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];if(!row)throw new DomainError('TYPED_IMPORT_NOT_FOUND','Source receipt not found',404);return row;}
async function items(db:Database,id:string) {return (await db.query<Item>('SELECT * FROM record_typed_rows WHERE batch_id=$1 ORDER BY row_number',[id])).rows;}
async function current(deps:TypedImportDeps,db:Database,a:PartnerActor,j:TypedBatchRow,operation:'preview'|'read'|'commit'|'replay'='read') {
 requireReconstructionFeature('typedIntake');
 if(j.organization_id!==a.merchantId||j.environment!==a.environment||j.principal_id!==a.principalId||j.credential_id!==a.credentialId||a.delegationGrantId)throw new DomainError('TYPED_IMPORT_NOT_FOUND','Source receipt not found',404);
 await reauthorizePartner(db,deps.clock,a,operation==='read'?'imports:read':'imports:write');
 const approved=await requireTypedSourceAuthority(db,deps.clock,a,authorityInput(j.contract),operation);
 if(operation!=='read'&&Number(approved.grantRevision)!==Number(j.grant_revision))fail('SOURCE_GRANT_CHANGED','This retained original keeps its original approval grant; review recovery explicitly',403);
 if(approved.operatorMembershipId!==j.operator_membership_id)fail('SOURCE_AUTHORIZATION_CHANGED','This retained original keeps its original approved operator',403);
 const c=(await db.query<{control_revision:string|number;paused:boolean}>('SELECT control_revision,paused FROM record_connection_state WHERE connection_id=$1',[j.connection_id])).rows[0];
 if(c?.paused)fail('CONNECTION_PAUSED','This source is paused');
 if(String(c?.control_revision??0)!==String(j.source_control_revision))fail('SOURCE_AUTHORIZATION_CHANGED','Review this retained original under its original source revision before recovery',403);
 return approved;
}
function view(j:TypedBatchRow,rs:Item[]) {
 const counts={processing:0,acceptedLinked:0,acceptedUnlinked:0,duplicate:0,conflict:0,quarantined:0,rejected:0};
 const key:Record<Outcome,keyof typeof counts>={processing:'processing',accepted_linked:'acceptedLinked',accepted_unlinked:'acceptedUnlinked',duplicate:'duplicate',conflict:'conflict',quarantined:'quarantined',rejected:'rejected'};
 for(const row of rs)counts[key[row.status]]++;
 if(rs.length!==Number(j.row_count))fail('TYPED_RECEIPT_ACCOUNTING_FAILED','The retained receipt has incomplete row accounting',503);
 return {id:j.id,operationId:j.id,resourceType:'typed_import' as const,state:j.state,previewVersion:j.preview_version,subscriptionId:j.subscription_id,configurationRevision:Number(j.configuration_revision),connectionId:j.connection_id,locationId:j.location_id,sourceProfile:j.source_profile,sourceNamespace:j.source_namespace,mappingVersion:j.mapping_version,rowCount:Number(j.row_count),counts,
  original:{name:j.original_name,mediaType:j.original_media_type,sha256:j.original_sha256,byteSize:Number(j.original_byte_size),versionBound:j.original_version_id!=='null'},
  rows:rs.map((r,index)=>({id:r.id,index,rowNumber:r.row_number,status:r.status,raw:r.source_values,normalized:r.normalized,payloadSha256:r.payload_sha256,errors:r.errors,errorCode:r.error_code,historyEligibility:r.history_eligibility,caseId:r.case_id,duplicateOf:r.duplicate_of,supersedesId:r.supersedes_id})),
  caseIds:[...new Set(rs.flatMap(r=>r.case_id?[r.case_id]:[]))],receivedAt:iso(j.received_at),updatedAt:iso(j.updated_at),errorCode:j.error_code,links:{self:`/v1/partner/typed-imports/${j.id}`},assurance:'source_reported',physicalCondition:'not_established'};
}
export async function readTypedImport(deps:TypedImportDeps,a:PartnerActor,id:string) {const j=await batch(deps.db,id);await current(deps,deps.db,a,j);const result=view(j,await items(deps.db,id));await current(deps,deps.db,a,j);return result;}

/** The installed collector verifies materialized source values without gaining
 * access to the remainder of a multi-source case. No raw original is returned. */
export async function readTypedImportRecordSubset(deps:TypedImportDeps,a:PartnerActor,id:string) {
 const j=await batch(deps.db,id);await current(deps,deps.db,a,j);
 const rs=await items(deps.db,id),rows=[];
 const reference=(r:{namespace:string;entity_type:string;external_id:string;parent_external_id:string})=>({namespace:r.namespace,type:r.entity_type,externalId:r.external_id,...(r.parent_external_id?{parentExternalId:r.parent_external_id}:{})});
 for(const row of rs){
  if(!['accepted_linked','duplicate'].includes(row.status)||!row.case_id)continue;
  const sourceId=row.duplicate_of??row.id;
  const authorized=(await deps.db.query<{revision:string|number}>(`SELECT c.revision FROM record_cases c JOIN record_typed_rows r ON r.case_id=c.id JOIN record_typed_batches b ON b.id=r.batch_id WHERE r.id=$1 AND r.case_id=$2 AND c.organization_id=$3 AND c.environment=$4 AND c.location_id=$5 AND c.operator_membership_id=$6 AND b.connection_id=$7 AND r.payload_sha256=$8`,[sourceId,row.case_id,j.organization_id,j.environment,j.location_id,j.operator_membership_id,j.connection_id,row.payload_sha256])).rows[0];
  if(!authorized)continue;
  const assertions=(await deps.db.query<{id:string;namespace:string;entity_type:string;external_id:string;parent_external_id:string;property:string;value:unknown;source_locator:unknown;source_revision:string;mapping_version:string;occurred_at:Date|string|null;source_as_of:Date|string|null;time_quality:string}>(`SELECT a.*,e.namespace,e.entity_type,e.external_id,e.parent_external_id FROM record_case_assertions a JOIN record_case_entities e ON e.id=a.entity_id WHERE a.observation_id=$1 AND a.case_id=$2 ORDER BY a.id`,[sourceId,row.case_id])).rows.map(r=>({id:r.id,subjectReference:reference(r),property:r.property,value:r.value,sourceLocator:r.source_locator,sourceRevision:r.source_revision,mappingVersion:r.mapping_version,occurredAt:r.occurred_at===null?null:iso(r.occurred_at),sourceAsOf:r.source_as_of===null?null:iso(r.source_as_of),timeQuality:r.time_quality}));
  const relationships=(await deps.db.query<{id:string;relation_type:string;quantity:unknown;from_namespace:string;from_type:string;from_external_id:string;from_parent:string;to_namespace:string;to_type:string;to_external_id:string;to_parent:string}>(`SELECT r.id,r.relation_type,r.quantity,f.namespace AS from_namespace,f.entity_type AS from_type,f.external_id AS from_external_id,f.parent_external_id AS from_parent,t.namespace AS to_namespace,t.entity_type AS to_type,t.external_id AS to_external_id,t.parent_external_id AS to_parent FROM record_case_relations r JOIN record_case_entities f ON f.id=r.from_entity_id JOIN record_case_entities t ON t.id=r.to_entity_id WHERE r.assertion_row_id=$1 AND r.case_id=$2 ORDER BY r.id`,[sourceId,row.case_id])).rows.map(r=>({id:r.id,from:reference({namespace:r.from_namespace,entity_type:r.from_type,external_id:r.from_external_id,parent_external_id:r.from_parent}),to:reference({namespace:r.to_namespace,entity_type:r.to_type,external_id:r.to_external_id,parent_external_id:r.to_parent}),type:r.relation_type,quantity:r.quantity}));
  rows.push({rowNumber:row.row_number,observationId:sourceId,status:row.status,caseId:row.case_id,projectionRevision:Number(authorized.revision),historyEligibility:row.history_eligibility,assertions,relationships});
 }
 await current(deps,deps.db,a,j);
 return {schema:'packproof.typed-import-records/v1',batchId:id,originalSha256:j.original_sha256,rows};
}

function historyEligibility(n:TypedSourceObservation,config:{historyFrom:string;historyTo:string|null}):Item['history_eligibility'] {
 const time=n.occurredAt??n.sourceAsOf;
 if(time===null)return 'unknown';
 if(Date.parse(time)<Date.parse(config.historyFrom)||config.historyTo&&Date.parse(time)>Date.parse(config.historyTo))return 'out_of_bounds';
 return 'within_bounds';
}
function historyError(n:TypedSourceObservation,config:{historyFrom:string;historyTo:string|null;unknownTimePolicy?:'quarantine'|'retain_unknown'}) {
 const eligibility=historyEligibility(n,config);
 if(eligibility==='unknown'&&config.unknownTimePolicy!=='retain_unknown')return 'SOURCE_HISTORY_TIME_UNKNOWN';
 if(eligibility==='out_of_bounds')return 'SOURCE_HISTORY_BOUNDARY';
 return null;
}
export async function previewTypedImport(deps:TypedImportDeps,a:PartnerActor,input:unknown,key:unknown) {
 requireReconstructionFeature('typedIntake');
 const parsed=parseTypedSourceBatch(input);
 if(!parsed.subscriptionId||parsed.configurationRevision===null)fail('SOURCE_AUTHORIZATION_REQUIRED','Approve this exact source subscription before uploading',403);
 await reauthorizePartner(deps.db,deps.clock,a,'imports:write');
 await requireTypedSourceAuthority(deps.db,deps.clock,a,authorityInput(parsed),'preview');
 const result=await idempotent(deps.db,deps.clock,a.tenantId,`typed-preview:${a.environment}:${a.principalId}:${a.credentialId}`,key,input,async tx=>{
  const approved=await requireTypedSourceAuthority(tx,deps.clock,a,authorityInput(parsed),'preview');
  await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${a.merchantId}:${parsed.connectionId}`]);
  const control=(await tx.query<{paused:boolean;control_revision:string|number}>('SELECT paused,control_revision FROM record_connection_state WHERE connection_id=$1',[parsed.connectionId])).rows[0];
  if(control?.paused)fail('CONNECTION_PAUSED','This source connection is paused');
  const count=(await tx.query<{n:string}>(`SELECT COUNT(*)::text n FROM record_typed_batches WHERE organization_id=$1 AND environment=$2 AND (state IN ('queued','running') OR (state='previewed' AND received_at>$3))`,[a.merchantId,a.environment,new Date(deps.clock.now().getTime()-86400000).toISOString()])).rows[0];
  if(Number(count.n)>=50)fail('TYPED_IMPORT_LIMIT_REACHED','Finish queued source receipts or wait for the rolling preview allowance');
  if(parsed.rows.length>approved.config.maxRows||Buffer.byteLength(parsed.original.content)>approved.config.maxBytes)fail('SOURCE_LIMIT_EXCEEDED','The original exceeds this approved source limit',413);
  const id=newId('typed_import'),bytes=Buffer.from(parsed.original.content,'utf8'),digest=sha256Hex(bytes),objectKey=`evidence/${a.merchantId}/${id}/committed/sha256-${digest}`;
  if(!deps.objectStore.putIfAbsent)fail('IMPORT_STORAGE_UNAVAILABLE','Create-only version-bound source storage is required',503);
  await deps.objectStore.putIfAbsent!(objectKey,bytes,parsed.original.mediaType);
  const stored=await deps.objectStore.digest(objectKey);
  if(!stored||stored.sha256!==digest||stored.byteSize!==bytes.length||!stored.versionId||!deps.devAuth&&stored.versionId==='null')fail('IMPORT_ORIGINAL_UNVERIFIED','The complete original could not be preserved at an exact verified storage version',503);
  await requireTypedSourceAuthority(tx,deps.clock,a,authorityInput(parsed),'preview');
  const {rows:_,...contractWithBytes}=parsed;
  const contract={...contractWithBytes,original:{...parsed.original,content:''}};
  const now=deps.clock.now().toISOString(),previewVersion=sha256Hex(canonicalize({schema:parsed.schema,subscriptionId:parsed.subscriptionId,configurationRevision:parsed.configurationRevision,sha256:digest,profile:parsed.sourceProfile,mappingVersion:parsed.mappingVersion,mapping:parsed.mapping,constants:parsed.constants,locationId:parsed.locationId,sourceNamespace:parsed.sourceNamespace,completeness:parsed.completeness}));
  await tx.query(`INSERT INTO record_typed_batches(id,organization_id,environment,connection_id,location_id,subscription_id,configuration_revision,principal_id,credential_id,actor_context,operator_membership_id,source_profile,source_namespace,mapping_version,preview_version,source_control_revision,original_name,original_media_type,original_object_key,original_version_id,original_sha256,original_byte_size,contract,row_count,state,received_at,updated_at,next_attempt_at,grant_revision)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,'previewed',$25,$25,$25,$26)`,[id,a.merchantId,a.environment,parsed.connectionId,parsed.locationId,parsed.subscriptionId,parsed.configurationRevision,a.principalId,a.credentialId,JSON.stringify(a),approved.operatorMembershipId,parsed.sourceProfile,parsed.sourceNamespace,parsed.mappingVersion,previewVersion,control?.control_revision??0,parsed.original.name,parsed.original.mediaType,objectKey,stored!.versionId,digest,bytes.length,JSON.stringify(contract),parsed.rows.length,now,approved.grantRevision]);
  for(const row of parsed.rows){const history=row.normalized?historyError(row.normalized,approved.config):null;
   await tx.query(`INSERT INTO record_typed_rows(id,batch_id,row_number,source_event_id,source_revision,payload_sha256,source_values,normalized,errors,status,error_code,received_at,history_eligibility) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,[newId('typed_row'),id,row.rowNumber,row.normalized?.sourceEventId??null,row.normalized?.sourceRevision??null,row.payloadSha256,JSON.stringify(row.raw),JSON.stringify(row.normalized),JSON.stringify(row.errors),row.normalized&&!history?'processing':'quarantined',history??(row.normalized?null:'SOURCE_ROW_INVALID'),now,row.normalized?historyEligibility(row.normalized,approved.config):'unknown']);
  }
  await auditOrganization(tx,deps.clock,{actor:a,requestId:a.requestId,operation:'TYPED_SOURCE_PREVIEWED',resourceId:id});
  return {id};
 });
 return {value:await readTypedImport(deps,a,result.value.id),replayed:result.replayed};
}
export async function commitTypedImport(deps:TypedImportDeps,a:PartnerActor,id:string,input:unknown,key:unknown) {
 requireReconstructionFeature('typedIntake');
 const body=strictBody(input,['previewVersion','originalSha256','importValidRows']);
 if(typeof body.previewVersion!=='string'||typeof body.originalSha256!=='string'||typeof body.importValidRows!=='boolean')fail('INVALID_TYPED_COMMIT','Confirm the exact preview, original digest and partial-row policy',400);
 await current(deps,deps.db,a,await batch(deps.db,id),'commit');
 const result=await idempotent(deps.db,deps.clock,a.tenantId,`typed-commit:${a.environment}:${a.principalId}:${a.credentialId}:${id}`,key,input,async tx=>{
  const j=await batch(tx,id,true);await current(deps,tx,a,j,'commit');
  if(j.preview_version!==body.previewVersion||j.original_sha256!==body.originalSha256)fail('TYPED_PREVIEW_CHANGED','Review the exact retained original and its current preview before committing');
  if(j.state!=='previewed')return {id};
  const rs=await items(tx,id);
  if(!body.importValidRows&&rs.some(r=>r.status==='quarantined'))fail('TYPED_IMPORT_HAS_ROW_ERRORS','Repair the highlighted rows or explicitly approve importing the valid subset');
  if(!rs.some(r=>r.status==='processing'))fail('TYPED_IMPORT_NO_VALID_ROWS','Review source errors before starting this import');
  await tx.query("UPDATE record_typed_batches SET state='queued',import_valid_rows=$2,updated_at=$3 WHERE id=$1",[id,body.importValidRows,deps.clock.now().toISOString()]);
  await auditOrganization(tx,deps.clock,{actor:a,requestId:a.requestId,operation:'TYPED_SOURCE_COMMITTED',resourceId:id});return {id};
 });
 return {value:await readTypedImport(deps,a,result.value.id),replayed:result.replayed};
}

async function projectRow(deps:TypedImportDeps,db:Database,j:TypedBatchRow,row:Item) {
 const n=row.normalized!;
 const identity=[j.organization_id,j.environment,j.connection_id,j.location_id,n.sourceEventId,n.sourceRevision];
 await db.query('SELECT pg_advisory_xact_lock(1347438154,hashtext($1))',[canonicalize(identity)]);
 const old=(await db.query<{row_id:string;payload_sha256:string}>(`SELECT row_id,payload_sha256 FROM record_typed_identities WHERE organization_id=$1 AND environment=$2 AND connection_id=$3 AND location_id=$4 AND source_event_id=$5 AND source_revision=$6`,identity)).rows[0];
 if(old&&old.row_id!==row.id){
  const same=old.payload_sha256===row.payload_sha256;
  const association=same?(await db.query<{case_id:string}>(`SELECT r.case_id FROM record_typed_rows r JOIN record_cases c ON c.id=r.case_id WHERE r.id=$1 AND c.organization_id=$2 AND c.environment=$3 AND c.location_id=$4 AND c.operator_membership_id=$5`,[old.row_id,j.organization_id,j.environment,j.location_id,j.operator_membership_id])).rows[0]:undefined;
  await db.query('UPDATE record_typed_rows SET status=$2,duplicate_of=$3,error_code=$4,case_id=$5 WHERE id=$1',[row.id,same?'duplicate':'conflict',old.row_id,same?null:'SOURCE_EVENT_CONFLICT',association?.case_id??null]);return;
 }
 if(!old)await db.query('INSERT INTO record_typed_identities(organization_id,environment,connection_id,location_id,source_event_id,source_revision,row_id,payload_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[...identity,row.id,row.payload_sha256]);
 let prior:Item|undefined;
 if(n.supersedes){
  prior=(await db.query<Item>(`SELECT r.* FROM record_typed_identities i JOIN record_typed_rows r ON r.id=i.row_id WHERE i.organization_id=$1 AND i.environment=$2 AND i.connection_id=$3 AND i.location_id=$4 AND i.source_event_id=$5 AND i.source_revision=$6`,[j.organization_id,j.environment,j.connection_id,j.location_id,n.supersedes.sourceEventId,n.supersedes.sourceRevision])).rows[0];
  if(!prior||!['accepted_linked','accepted_unlinked'].includes(prior.status)){await db.query("UPDATE record_typed_rows SET status='accepted_unlinked',error_code='SUPERSEDED_SOURCE_NOT_AVAILABLE' WHERE id=$1",[row.id]);return;}
  const competing=(await db.query(`SELECT 1 FROM record_typed_rows WHERE supersedes_id=$1 AND id<>$2 AND status IN ('accepted_linked','accepted_unlinked') LIMIT 1`,[prior.id,row.id])).rows[0];
  if(competing){await db.query("UPDATE record_typed_rows SET status='conflict',error_code='SOURCE_REVISION_BRANCH' WHERE id=$1",[row.id]);return;}
  // A revision cannot silently change the operational subject it corrects.
  const oldSubjects=prior.normalized!.references.filter(r=>['order','order_line','shipment','return'].includes(r.type)).map(r=>canonicalize(r)).sort();
  const subjects=n.references.filter(r=>['order','order_line','shipment','return'].includes(r.type)).map(r=>canonicalize(r)).sort();
  if(canonicalize(oldSubjects)!==canonicalize(subjects)){await db.query("UPDATE record_typed_rows SET status='conflict',error_code='SOURCE_REVISION_SUBJECT_CHANGED' WHERE id=$1",[row.id]);return;}
  await db.query('UPDATE record_typed_rows SET supersedes_id=$2 WHERE id=$1',[row.id,prior.id]);
 }else{
  const another=(await db.query(`SELECT 1 FROM record_typed_identities i JOIN record_typed_rows r ON r.id=i.row_id WHERE i.organization_id=$1 AND i.environment=$2 AND i.connection_id=$3 AND i.location_id=$4 AND i.source_event_id=$5 AND i.source_revision<>$6 AND NOT(COALESCE(r.normalized->'supersedes'->>'sourceEventId'=$5 AND r.normalized->'supersedes'->>'sourceRevision'=$6,false)) LIMIT 1`,identity)).rows[0];
  if(another){await db.query("UPDATE record_typed_rows SET status='conflict',error_code='SOURCE_REVISION_REQUIRES_SUPERSESSION' WHERE id=$1",[row.id]);return;}
 }
 if(!reconstructionFeatureEnabled('reconstruction')){await db.query("UPDATE record_typed_rows SET status='accepted_unlinked',error_code='PROJECTION_DISABLED' WHERE id=$1",[row.id]);return;}
 await applyOperationalObservation(db,deps.clock,{organizationId:j.organization_id,environment:j.environment,locationId:j.location_id,operatorMembershipId:j.operator_membership_id,actor:j.actor_context,batchId:j.id,rowId:row.id,rowNumber:row.row_number,receivedAt:iso(row.received_at),source:j.contract as TypedSourceBatch},n);
}
async function verifyOriginal(deps:TypedImportDeps,j:TypedBatchRow) {
 const original=await deps.objectStore.get(j.original_object_key,{versionId:j.original_version_id});
 if(!original||original.body.length!==Number(j.original_byte_size)||sha256Hex(original.body)!==j.original_sha256)fail('TYPED_ORIGINAL_INTEGRITY_FAILED','The exact retained source original is unavailable or changed',503);
 const {headers:_,...originalContract}=j.contract;
 const parsed=parseTypedSourceBatch({...originalContract,original:{...j.contract.original,content:original!.body.toString('utf8')}});
 if(parsed.rows.length!==Number(j.row_count))fail('TYPED_ORIGINAL_INTEGRITY_FAILED','The retained original has inconsistent row accounting',503);
 return parsed;
}
function checkLease(j:TypedBatchRow,token:string,deps:TypedImportDeps) {if(j.state!=='running'||j.lease_token!==token||!j.lease_expires_at||new Date(j.lease_expires_at).getTime()<=deps.clock.now().getTime())fail('TYPED_IMPORT_LEASE_LOST','The worker lease has expired or changed');}
/** Bounded worker: durable acceptance is independent of projection success.
 * All row outcomes and case/outbox changes commit in the same transaction. */
export async function processPendingTypedImports(deps:TypedImportDeps,limit=2) {
 if(!reconstructionFeatureEnabled('typedIntake'))return {processed:0,blocked:0,replayed:0};
 let processed=0,blocked=0;
 for(let i=0;i<Math.max(1,Math.min(limit,10));i++){
  const token=newId('typed_lease'),claimed=await deps.db.transaction(async tx=>{
   const j=(await tx.query<TypedBatchRow>(`SELECT * FROM record_typed_batches WHERE (state='queued' AND next_attempt_at<=$1) OR (state='running' AND lease_expires_at<=$1) ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[deps.clock.now().toISOString()])).rows[0];if(!j)return null;
   await tx.query("UPDATE record_typed_batches SET state='running',lease_token=$2,lease_expires_at=$3,attempts=attempts+1,updated_at=$4,error_code=NULL WHERE id=$1",[j.id,token,new Date(deps.clock.now().getTime()+120000).toISOString(),deps.clock.now().toISOString()]);return j;
  });
  if(!claimed)break;
  try{
   const parsed=await verifyOriginal(deps,claimed);
   await deps.db.transaction(async tx=>{
    const j=await batch(tx,claimed.id,true);checkLease(j,token,deps);const approved=await current(deps,tx,j.actor_context,j,'replay');
    const rs=await items(tx,j.id);if(rs.length!==j.row_count)fail('TYPED_RECEIPT_ACCOUNTING_FAILED','Source receipt rows are missing',503);
    for(const row of rs){
     if(row.status!=='processing'&&!(j.replay_requested&&['accepted_linked','accepted_unlinked'].includes(row.status)))continue;
     const original=parsed.rows.find(r=>r.rowNumber===row.row_number);
     if(!original||original.payloadSha256!==row.payload_sha256||canonicalize(original.normalized)!==canonicalize(row.normalized))fail('TYPED_ORIGINAL_INTEGRITY_FAILED','A retained row no longer matches its exact original',503);
     const history=row.normalized?historyError(row.normalized,approved.config):'SOURCE_ROW_INVALID';
     if(history){await tx.query("UPDATE record_typed_rows SET status='quarantined',error_code=$2 WHERE id=$1",[row.id,history]);continue;}
     await projectRow(deps,tx,j,row);
    }
    if(reconstructionFeatureEnabled('reconstruction'))await attachQualifiedShipmentProofs(tx,deps.clock,j.actor_context,j.id);
    checkLease(j,token,deps);await current(deps,tx,j.actor_context,j,'replay');
    const final=await items(tx,j.id),bad=final.some(r=>['rejected','quarantined','conflict'].includes(r.status)),good=final.some(r=>['accepted_linked','accepted_unlinked','duplicate'].includes(r.status));
    await tx.query('UPDATE record_typed_batches SET state=$2,lease_token=NULL,lease_expires_at=NULL,replay_requested=false,updated_at=$3 WHERE id=$1',[j.id,bad?(good?'partially_succeeded':'failed'):'succeeded',deps.clock.now().toISOString()]);
    await auditOrganization(tx,deps.clock,{actor:j.actor_context,requestId:j.id,operation:'TYPED_SOURCE_PROCESSED',resourceId:j.id});
   });processed++;
  }catch(error){
   const code=error instanceof DomainError?error.code:'TYPED_IMPORT_RETRY_REQUIRED';
   const retryable=!(error instanceof DomainError)||error.httpStatus>=500&&!['TYPED_ORIGINAL_INTEGRITY_FAILED','TYPED_RECEIPT_ACCOUNTING_FAILED'].includes(code);
   const retry=retryable&&Number(claimed.attempts)<5,at=deps.clock.now().toISOString(),next=new Date(deps.clock.now().getTime()+Math.min(300000,1000*2**Number(claimed.attempts))).toISOString();
   await deps.db.query('UPDATE record_typed_batches SET state=$3,error_code=$4,lease_token=NULL,lease_expires_at=NULL,updated_at=$5,next_attempt_at=$6 WHERE id=$1 AND lease_token=$2',[claimed.id,token,retry?'queued':'blocked_policy',code,at,next]);blocked++;
  }
 }
 const replayed=await replayPendingTypedRows(deps,25);
 return {processed,blocked,replayed};
}
/** Indexed, bounded replay. Current source authority is checked again; a
 * crosswalk never grants permission to another tenant or source's original. */
export async function replayPendingTypedRows(deps:TypedImportDeps,limit=25) {
 if(!reconstructionFeatureEnabled('typedIntake')||!reconstructionFeatureEnabled('reconstruction'))return 0;
 const pending=(await deps.db.query<{id:string;batch_id:string}>(`SELECT r.id,r.batch_id FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE r.status='accepted_unlinked' AND b.state IN ('succeeded','partially_succeeded') ORDER BY r.resolution_attempts,r.received_at,r.id LIMIT $1`,[Math.max(1,Math.min(limit,100))])).rows;
 let linked=0;
 for(const r of pending){
  try{await deps.db.transaction(async tx=>{
   const j=await batch(tx,r.batch_id,true);await current(deps,tx,j.actor_context,j,'replay');
   const row=(await tx.query<Item>('SELECT * FROM record_typed_rows WHERE id=$1 FOR UPDATE',[r.id])).rows[0];if(!row||row.status!=='accepted_unlinked')return;
   await projectRow(deps,tx,j,row);
   const after=(await tx.query<{status:Outcome}>('SELECT status FROM record_typed_rows WHERE id=$1',[row.id])).rows[0];if(after.status==='accepted_linked')linked++;
  });}catch{/* Preserve the accepted row and its original authority for explicit recovery. */}
  await deps.db.query('UPDATE record_typed_rows SET resolution_attempts=resolution_attempts+1 WHERE id=$1',[r.id]);
 }
 return linked;
}

/** Explicit recovery of a policy-blocked retained batch; it never adopts a new
 * configuration or principal. Repair authority, then resume the same receipt. */
export async function resumeTypedImport(deps:TypedImportDeps,a:PartnerActor,id:string,key:unknown) {
 const j=await batch(deps.db,id);await current(deps,deps.db,a,j,'replay');
 const result=await idempotent(deps.db,deps.clock,a.tenantId,`typed-resume:${a.principalId}:${a.credentialId}:${id}`,key,{},async tx=>{
  const retained=await batch(tx,id,true);await current(deps,tx,a,retained,'replay');
  if(retained.state==='blocked_policy')await tx.query("UPDATE record_typed_batches SET state='queued',error_code=NULL,updated_at=$2,next_attempt_at=$2 WHERE id=$1",[id,deps.clock.now().toISOString()]);
  else if(['succeeded','partially_succeeded'].includes(retained.state)){
   await tx.query("UPDATE record_typed_batches SET state='queued',replay_requested=true,updated_at=$2,next_attempt_at=$2 WHERE id=$1",[id,deps.clock.now().toISOString()]);
   await auditOrganization(tx,deps.clock,{actor:a,requestId:a.requestId,operation:'TYPED_SOURCE_RECONCILIATION_REQUESTED',resourceId:id});
  }else fail('TYPED_RESUME_UNAVAILABLE','Reconcile a preserved blocked or completed receipt');
  return {id};
 });return {value:await readTypedImport(deps,a,id),replayed:result.replayed};
}
