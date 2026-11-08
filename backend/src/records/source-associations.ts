import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { strictBody, reauthorizePartner, authorizePartnerProof, auditOrganization, type PartnerActor } from '../platform/organizations.js';
import { idempotent } from '../platform/idempotency.js';
import { textField } from '../platform/tenants.js';
import { requireRecordWorkspace, requireRecordAccess, requireRecordLocation, type RecordWorkspace } from './access.js';
import { acceptSourceIngestion, parseSourceIngestion } from './ingestions.js';
import { addRecordEntity, ensureRecordState } from './service.js';
import { decideSourceReference, shipmentBindingKey, SOURCE_REFERENCE_RULE, type SourceReference } from './source-reference.js';

const iso=(value:string|Date)=>new Date(value).toISOString();
const fail=(code:string,message:string,status=409):never=>{throw new DomainError(code,message,status);};
function reference(input:unknown):SourceReference {
 const b=strictBody(input,['type','externalId']);
 if(!['SHIPMENT','ORDER','RETURN','package','pallet','item'].includes(String(b.type)))fail('INVALID_SOURCE_REFERENCE','Use a shipment, order, return or approved child reference',400);
 const externalId=textField(b.externalId,'externalId');
 if(externalId!==b.externalId)fail('INVALID_SOURCE_REFERENCE','Source references must use their exact nonempty representation',400);
 return {type:b.type as SourceReference['type'],externalId};
}
function scope(input:unknown) {
 const b=strictBody(input,['connectionId','locationId','reference']);
 if(b.locationId!==null&&typeof b.locationId!=='string')fail('SOURCE_LOCATION_REQUIRED','Supply the exact authorized locationId, or explicit null for an unlocated source',400);
 return {connectionId:textField(b.connectionId,'connectionId'),locationId:b.locationId===null?null:textField(b.locationId,'locationId'),reference:reference(b.reference)};
}
async function connection(db:Database,clock:Clock,a:PartnerActor,id:string,locationId:string|null) {
 await reauthorizePartner(db,clock,a,'proofs:write');
 if(a.delegationGrantId)fail('SOURCE_DELEGATION_UNQUALIFIED','Reference intake requires a direct merchant source until an explicit delegated source/location contract is qualified',403);
 const row=(await db.query<{paused:boolean|null;control_revision:string|number|null}>(`SELECT s.paused,s.control_revision FROM platform_integration_accounts a LEFT JOIN record_connection_state s ON s.connection_id=a.id WHERE a.id=$1 AND a.merchant_id=$2 AND a.environment=$3`,[id,a.merchantId,a.environment])).rows[0];
 if(!row)fail('CONNECTION_NOT_FOUND','Source connection not found',404);
 if(row.paused)fail('CONNECTION_PAUSED','Resume this source before submitting or replaying observations');
 if(locationId&&!(await db.query('SELECT 1 FROM record_locations WHERE id=$1 AND organization_id=$2',[locationId,a.merchantId])).rows[0])fail('LOCATION_NOT_FOUND','Location not found',404);
 // This endpoint must not broaden an enrolled Windows installation's CSV-only
 // authority when invoked directly rather than through the HTTP route guard.
 if((await db.query('SELECT 1 FROM record_agent_installations WHERE principal_id=$1',[a.principalId])).rows[0])fail('AGENT_OPERATION_DENIED','This installation is restricted to its approved CSV source',403);
 return row.control_revision??0;
}
export async function resolveSourceReference(db:Database,clock:Clock,a:PartnerActor,input:unknown) {
 const s=scope(input);await connection(db,clock,a,s.connectionId,s.locationId);
 const params=[a.merchantId,a.environment,s.connectionId,s.locationId,s.reference.type,s.reference.externalId,shipmentBindingKey(s.reference.externalId,s.locationId)];
 const direct=(await db.query<{proof_id:string}>(`SELECT DISTINCT b.proof_id FROM platform_external_bindings b LEFT JOIN record_state r ON r.proof_id=b.proof_id
 WHERE b.merchant_id=$1 AND b.environment=$2 AND b.integration_account_id=$3 AND r.location_id IS NOT DISTINCT FROM $4 AND b.resource_type=$5 AND (
  (b.external_id=$6 AND ($5<>'SHIPMENT' OR b.external_id !~ '^location:v1:[a-f0-9]{64}$'
   OR EXISTS(SELECT 1 FROM partner_import_rows original JOIN partner_import_jobs j ON j.id=original.import_id WHERE original.proof_id=b.proof_id AND j.integration_account_id=b.integration_account_id AND original.normalized->>'shipmentReference'=$6 AND original.normalized->>'locationId' IS NOT DISTINCT FROM $4)))
  OR ($5='SHIPMENT' AND $4::text IS NOT NULL AND b.external_id=$7)) ORDER BY b.proof_id LIMIT 2`,params)).rows.map(r=>r.proof_id);
 const crosswalk=(await db.query<{proof_id:string}>(`SELECT c.proof_id FROM record_source_crosswalks c LEFT JOIN record_state r ON r.proof_id=c.proof_id
 WHERE c.organization_id=$1 AND c.environment=$2 AND c.connection_id=$3 AND c.location_id IS NOT DISTINCT FROM $4 AND r.location_id IS NOT DISTINCT FROM $4 AND c.reference_type=$5 AND c.external_id=$6 LIMIT 2`,params.slice(0,6))).rows.map(r=>r.proof_id);
 const children=['package','pallet','item'].includes(s.reference.type)?(await db.query<{proof_id:string}>(`SELECT DISTINCT e.proof_id FROM record_entities e JOIN platform_proof_ownership o ON o.proof_id=e.proof_id LEFT JOIN record_state r ON r.proof_id=e.proof_id
 WHERE o.merchant_id=$1 AND o.environment=$2 AND r.location_id IS NOT DISTINCT FROM $4 AND e.kind=$5 AND e.external_reference=$6
 AND NOT EXISTS(SELECT 1 FROM record_entities newer WHERE newer.supersedes_id=e.id)
 AND e.attributes->>'sourceConnectionId'=$3
 AND EXISTS(SELECT 1 FROM record_source_pending lineage WHERE lineage.id=e.attributes->>'sourceReceiptId' AND lineage.proof_id=e.proof_id AND lineage.connection_id=$3 AND lineage.organization_id=$1 AND lineage.environment=$2 AND lineage.state='submitted' AND EXISTS(SELECT 1 FROM jsonb_array_elements(lineage.normalized->'facts') fact WHERE fact->>'kind'=e.kind AND fact->>'externalReference'=e.external_reference))
 AND EXISTS(SELECT 1 FROM platform_external_bindings b WHERE b.merchant_id=$1 AND b.environment=$2 AND b.integration_account_id=$3 AND b.proof_id=e.proof_id) ORDER BY e.proof_id LIMIT 2`,params.slice(0,6))).rows.map(r=>r.proof_id):[];
 const result=decideSourceReference(direct,crosswalk,children);
 for(const id of result.candidates)await authorizePartnerProof(db,clock,a,id,'proofs:write');
 await connection(db,clock,a,s.connectionId,s.locationId);
 return result;
}
export function parseReferenceObservation(input:unknown) {
 const b=strictBody(input,['connectionId','locationId','reference','sourceKind','sourceSchemaVersion','mappingVersion','event','facts']);
 const s=scope({connectionId:b.connectionId,locationId:b.locationId,reference:b.reference});
 const source={sourceKind:textField(b.sourceKind,'sourceKind',80),sourceSchemaVersion:textField(b.sourceSchemaVersion,'sourceSchemaVersion',80),mappingVersion:textField(b.mappingVersion,'mappingVersion',80)};
 const e=strictBody(b.event,['sourceEventId','eventType','reportedAt','carrier','location','data']);
 const facts=b.facts??[];
 if(!Array.isArray(facts)||facts.length>25)fail('INVALID_SOURCE_FACTS','Supply at most 25 bounded entity facts',400);
 const identities=new Set<string>();
 for(const fact of facts as unknown[]){const f=strictBody(fact,['kind','externalReference','parentReference','attributes']);if(!['shipment','stop','package','pallet','item','return'].includes(String(f.kind)))fail('INVALID_SOURCE_FACTS','Unsupported entity kind',400);if(textField(f.externalReference,'externalReference')!==f.externalReference)fail('INVALID_SOURCE_FACTS','Entity references must not contain surrounding whitespace',400);const identity=canonicalize([f.kind,f.externalReference]);if(identities.has(identity))fail('INVALID_SOURCE_FACTS','One observation cannot repeat the same entity identity',400);identities.add(identity);if(f.parentReference!=null&&textField(f.parentReference,'parentReference')!==f.parentReference)fail('INVALID_SOURCE_FACTS','Parent references must not contain surrounding whitespace',400);if(f.attributes!=null&&(!f.attributes||typeof f.attributes!=='object'||Array.isArray(f.attributes)))fail('INVALID_SOURCE_FACTS','Entity attributes must be an object',400);}
 // Reuse the existing size, clock, secret and authority validation before any
 // durable acknowledgement. Preserve the complete original envelope separately.
 const validated=parseSourceIngestion({connectionId:s.connectionId,events:[{...e,proofId:'validation-only',data:{source,reference:s.reference,eventData:e.data??{},facts}}]});
 if(e.sourceEventId!==validated.events[0].sourceEventId)fail('INVALID_SOURCE_REFERENCE','Use the exact source event identifier without surrounding whitespace',400);
 if(Buffer.byteLength(canonicalize(b))>256*1024)fail('INGESTION_TOO_LARGE','Use at most 256 KiB per source observation',413);
 return {...s,...source,event:e as Record<string,unknown>&{sourceEventId:string},facts:facts as Array<Record<string,unknown>>};
}
interface Pending {id:string;organization_id:string;environment:'sandbox'|'live';connection_id:string;location_id:string|null;principal_id:string;credential_id:string;actor_context:PartnerActor;connection_revision:string|number;replay_revision:string|number|null;source_event_id:string;payload_canonical:string;payload_sha256:string;normalized:ReturnType<typeof parseReferenceObservation>;received_at:string|Date;state:string;operation_id:string|null;proof_id:string|null;attempts:number;error_code:string|null;resolution:Record<string,unknown>;updated_at:string|Date;}
function view(r:Pending){return {id:r.id,connectionId:r.connection_id,locationId:r.location_id,sourceEventId:r.source_event_id,reference:r.normalized.reference,sourceKind:r.normalized.sourceKind,sourceSchemaVersion:r.normalized.sourceSchemaVersion,mappingVersion:r.normalized.mappingVersion,reportedAt:r.normalized.event.reportedAt,state:r.state,operationId:r.operation_id,proofId:r.proof_id,attempts:r.attempts,errorCode:r.error_code,resolution:r.resolution,receivedAt:iso(r.received_at),updatedAt:iso(r.updated_at),sourceAssurance:'organization_submitted'};}
export async function acceptReferenceObservation(db:Database,clock:Clock,a:PartnerActor,input:unknown,key:unknown) {
 const n=parseReferenceObservation(input);await connection(db,clock,a,n.connectionId,n.locationId);
 const result=await idempotent(db,clock,a.tenantId,`reference-observation:${a.environment}:${a.principalId}:${a.credentialId}`,key,input,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${a.merchantId}:${n.connectionId}`]);
  const controlRevision=await connection(tx,clock,a,n.connectionId,n.locationId);
  await tx.query('SELECT pg_advisory_xact_lock(1347438151,hashtext($1))',[canonicalize([a.merchantId,a.environment,n.connectionId,n.locationId,n.event.sourceEventId])]);
  const payload=canonicalize(input),hash=sha256Hex(payload),prior=(await tx.query<Pending>('SELECT * FROM record_source_pending WHERE organization_id=$1 AND environment=$2 AND connection_id=$3 AND location_key=$4 AND source_event_id=$5 ORDER BY received_at,id',[a.merchantId,a.environment,n.connectionId,n.locationId??'',n.event.sourceEventId])).rows;
  const same=prior.find(r=>r.payload_sha256===hash);
  if(same){if(same.principal_id!==a.principalId||same.credential_id!==a.credentialId)fail('SOURCE_IDENTITY_OWNED','This source identity already has a receipt under another credential');return {id:same.id,duplicate:true};}
  const resolution=await resolveSourceReference(tx,clock,a,{connectionId:n.connectionId,locationId:n.locationId,reference:n.reference}),id=newId('association'),at=clock.now().toISOString();
  await tx.query(`INSERT INTO record_source_pending(id,organization_id,environment,connection_id,location_id,location_key,principal_id,credential_id,actor_context,source_event_id,payload_canonical,payload_sha256,received_at,state,next_attempt_at,updated_at,resolution,normalized,error_code,connection_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$13,$13,$15::jsonb,$16::jsonb,$17,$18)`,[id,a.merchantId,a.environment,n.connectionId,n.locationId,n.locationId??'',a.principalId,a.credentialId,JSON.stringify(a),n.event.sourceEventId,payload,hash,at,prior.length?'conflict':'pending',JSON.stringify(resolution),JSON.stringify(n),prior.length?'SOURCE_EVENT_CONFLICT':null,controlRevision]);
  await tx.query('INSERT INTO record_source_resolution_attempts(id,pending_id,outcome,created_at) VALUES($1,$2,$3::jsonb,$4)',[newId('resolution'),id,JSON.stringify({...resolution,phase:'accepted'}),at]);
  await auditOrganization(tx,clock,{actor:a,requestId:id,operation:'SOURCE_REFERENCE_ACCEPTED',resourceId:id});
  return {id,duplicate:false};
 });
 const row=await readReferenceObservation(db,clock,a,result.value.id);
 return {...row,replayed:result.replayed,duplicate:result.value.duplicate};
}
export async function readReferenceObservation(db:Database,clock:Clock,a:PartnerActor,id:string) {
 await reauthorizePartner(db,clock,a,'proofs:write');
 const row=(await db.query<Pending>('SELECT * FROM record_source_pending WHERE id=$1 AND organization_id=$2 AND environment=$3 AND principal_id=$4 AND credential_id=$5',[id,a.merchantId,a.environment,a.principalId,a.credentialId])).rows[0];
 if(!row)fail('OPERATION_NOT_FOUND','Source association not found',404);
 // Paused sources remain diagnosable, while current credential/record policy
 // is still authoritative. Candidate IDs are never returned without access.
 for(const proof of (row.resolution.candidates as string[]??[]))await authorizePartnerProof(db,clock,a,proof,'proofs:write');
 if(row.proof_id)await authorizePartnerProof(db,clock,a,row.proof_id,'proofs:write');
 return view(row);
}
export async function processSourceAssociations(db:Database,clock:Clock,limit=10) {
 let processed=0;
 for(let i=0;i<Math.max(0,Math.min(limit,50));i++){
  let selected:string|undefined;
  try {
   const did=await db.transaction(async tx=>{
    const candidate=(await tx.query<Pending>("SELECT * FROM record_source_pending WHERE state IN ('pending','retryable_error') AND next_attempt_at<=$1 ORDER BY next_attempt_at,received_at,id LIMIT 1",[clock.now().toISOString()])).rows[0];
    if(!candidate)return false;
    await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${candidate.organization_id}:${candidate.connection_id}`]);
    const r=(await tx.query<Pending>("SELECT * FROM record_source_pending WHERE id=$1 AND state IN ('pending','retryable_error') AND next_attempt_at<=$2 FOR UPDATE SKIP LOCKED",[candidate.id,clock.now().toISOString()])).rows[0];
    if(!r)return false;selected=r.id;
    if(sha256Hex(r.payload_canonical)!==r.payload_sha256)fail('SOURCE_RECEIPT_INTEGRITY_FAILED','The preserved source envelope failed its digest check');
    const n=r.normalized,a=r.actor_context;
    await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${a.merchantId}:${r.connection_id}`]);
    if(String(await connection(tx,clock,a,r.connection_id,r.location_id))!==String(r.replay_revision??r.connection_revision))fail('CONNECTION_CHANGED','Source controls changed after acceptance. A current administrator must authorize replay.');
    const resolution=await resolveSourceReference(tx,clock,a,{connectionId:n.connectionId,locationId:n.locationId,reference:n.reference}),at=clock.now().toISOString();
    await tx.query('INSERT INTO record_source_resolution_attempts(id,pending_id,outcome,created_at) VALUES($1,$2,$3::jsonb,$4)',[newId('resolution'),r.id,JSON.stringify(resolution),at]);
    if(!resolution.proofId){await tx.query('UPDATE record_source_pending SET resolution=$2::jsonb,attempts=attempts+1,next_attempt_at=$3,updated_at=$4 WHERE id=$1',[r.id,JSON.stringify(resolution),new Date(clock.now().getTime()+300000).toISOString(),at]);return true;}
    const proofId=resolution.proofId;
    const event={...n.event,sourceEventId:`reference:v1:${sha256Hex(canonicalize({connection:r.connection_id,location:r.location_id,id:r.source_event_id}))}`,proofId,data:{...(n.event.data as Record<string,unknown>??{}),sourceObservation:{receiptId:r.id,sourceEventId:r.source_event_id,reportedAt:n.event.reportedAt,receivedAt:iso(r.received_at),payloadSha256:r.payload_sha256,reference:n.reference,sourceKind:n.sourceKind,sourceSchemaVersion:n.sourceSchemaVersion,mappingVersion:n.mappingVersion,ruleVersion:SOURCE_REFERENCE_RULE}}};
    const accepted=await acceptSourceIngestion(tx,clock,a,{connectionId:r.connection_id,events:[event]},`association:${r.id}`);
    if(accepted.state==='failed')fail('SOURCE_EVENT_CONFLICT','The canonical source event identity already has conflicting details; entity facts were not applied.');
    const w:RecordWorkspace={organizationId:a.merchantId,environment:a.environment,tenantId:a.tenantId,membershipId:'',userId:a.actorUserId,role:'OPERATOR',enabled:true,locationScoped:false,partner:a,authorizationClock:clock};
    await ensureRecordState(tx,clock,w,proofId);
    const lockedLocation=(await tx.query<{location_id:string|null}>('SELECT location_id FROM record_state WHERE proof_id=$1',[proofId])).rows[0].location_id;
    if(lockedLocation!==r.location_id)fail('SOURCE_LOCATION_CHANGED','The record location changed during resolution. Review the exact source relationship before replay.');
    for(const fact of n.facts){
     const existing=(await tx.query<{id:string;attributes:Record<string,unknown>}>(`SELECT e.id,e.attributes FROM record_entities e WHERE e.proof_id=$1 AND e.kind=$2 AND e.external_reference=$3 AND NOT EXISTS(SELECT 1 FROM record_entities newer WHERE newer.supersedes_id=e.id) ORDER BY e.id LIMIT 2`,[proofId,fact.kind,fact.externalReference])).rows;
     if(existing.length>1)fail('SOURCE_ENTITY_CONFLICT','This entity reference requires an explicit source correction review');
     if(existing[0]){
      const previous=existing[0].attributes;
      const origin=await tx.query(`SELECT 1 FROM record_source_pending WHERE id=$1 AND proof_id=$2 AND connection_id=$3 AND state='submitted' AND EXISTS(SELECT 1 FROM jsonb_array_elements(normalized->'facts') f WHERE f->>'kind'=$5 AND f->>'externalReference'=$6) UNION ALL SELECT 1 FROM partner_import_jobs j JOIN partner_import_rows r ON r.import_id=j.id WHERE j.id=$4 AND r.proof_id=$2 AND j.integration_account_id=$3 AND $5='shipment' AND r.normalized->>'shipmentReference'=$6 LIMIT 1`,[previous.sourceReceiptId??null,proofId,r.connection_id,previous.importId??null,fact.kind,fact.externalReference]);
      if(!origin.rows[0])fail('SOURCE_ENTITY_CONFLICT','An entity from another source requires explicit correction review');
     }
     let parentId:string|null=null;
     if(fact.parentReference){const parent=(await tx.query<{id:string}>('SELECT e.id FROM record_entities e WHERE e.proof_id=$1 AND e.external_reference=$2 AND NOT EXISTS(SELECT 1 FROM record_entities newer WHERE newer.supersedes_id=e.id) ORDER BY e.id LIMIT 2',[proofId,fact.parentReference])).rows;if(parent.length!==1)fail('SOURCE_PARENT_UNRESOLVED','The parent reference is missing or ambiguous');parentId=parent[0].id;}
     await addRecordEntity(tx,clock,w,proofId,{kind:fact.kind,externalReference:fact.externalReference,parentId,attributes:{...(fact.attributes as object??{}),sourceConnectionId:r.connection_id,sourceReceiptId:r.id,sourceSchemaVersion:n.sourceSchemaVersion,mappingVersion:n.mappingVersion,sourceReportedAt:n.event.reportedAt},supersedesId:existing[0]?.id??null,reason:'Accepted organization source observation; not a human attestation'});
     await tx.query('UPDATE record_state SET revision=revision+1,updated_at=$2 WHERE proof_id=$1',[proofId,at]);
    }
    await connection(tx,clock,a,r.connection_id,r.location_id);
    await tx.query("UPDATE record_source_pending SET state='submitted',operation_id=$2,proof_id=$3,resolution=$4::jsonb,attempts=attempts+1,error_code=NULL,updated_at=$5 WHERE id=$1",[r.id,accepted.operationId,proofId,JSON.stringify(resolution),at]);
    return true;
   });if(!did)break;processed++;
  }catch(error){
   if(!selected)throw error;
   const permanent=error instanceof DomainError&&error.httpStatus<500,code=permanent?error.code:'SOURCE_PROCESSING_UNAVAILABLE';
   await db.query("UPDATE record_source_pending SET state=CASE WHEN $3='SOURCE_EVENT_CONFLICT' THEN 'conflict' WHEN $2 OR attempts>=4 THEN 'blocked_policy' ELSE 'retryable_error' END,error_code=$3,attempts=attempts+1,next_attempt_at=$4,updated_at=$5 WHERE id=$1 AND operation_id IS NULL",[selected,permanent,code,new Date(clock.now().getTime()+300000).toISOString(),clock.now().toISOString()]);processed++;
  }
 }
 return {processed};
}
export async function listSourceAssociations(db:Database,w:RecordWorkspace,input:{before?:unknown;limit?:unknown}={}) {
 const current=await requireRecordWorkspace(db,w.userId,w.organizationId,w.environment);
 if(current.role==='OPERATOR')fail('SOURCE_REVIEW_REQUIRED','Source exceptions require a workspace reviewer or administrator',403);
 const limit=input.limit===undefined?50:Number(input.limit);
 if(!Number.isInteger(limit)||limit<1||limit>100||input.before!==undefined&&(typeof input.before!=='string'||!/^association_[A-Za-z0-9_-]+$/.test(input.before)))fail('INVALID_LIMIT','Use a returned source cursor and a limit from 1 to 100',400);
 const rows=(await db.query<Pending>(`SELECT p.* FROM record_source_pending p WHERE organization_id=$1 AND environment=$2 AND state<>'submitted'
 AND ($3::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=$4 AND g.organization_id=p.organization_id AND g.location_id=p.location_id))
 AND ($5::text IS NULL OR p.id<$5) ORDER BY p.id DESC LIMIT $6`,[w.organizationId,w.environment,current.locationScoped,current.membershipId,input.before??null,limit+1])).rows;
 const items=rows.slice(0,limit);
 for(const r of items)for(const proof of r.resolution.candidates as string[]??[])await requireRecordAccess(db,current,proof);
 return {items:items.map(view),nextCursor:rows.length>limit?items.at(-1)!.id:null};
}
export async function approveSourceCrosswalk(db:Database,clock:Clock,w:RecordWorkspace,input:unknown,key:unknown) {
 if(w.partner)fail('SOURCE_ADMIN_REQUIRED','Source mappings require a current human administrator session',403);
 const b=strictBody(input,['organizationId','environment','connectionId','locationId','reference','proofId','ruleVersion','reason']);
 const s=scope({connectionId:b.connectionId,locationId:b.locationId,reference:b.reference}),proofId=textField(b.proofId,'proofId'),ruleVersion=textField(b.ruleVersion,'ruleVersion',100),reason=textField(b.reason,'reason',1000);
 return db.transaction(async tx=>{
  const current=await requireRecordWorkspace(tx,w.userId,w.organizationId,w.environment,true);
  if(!['OWNER','ADMIN'].includes(current.role))fail('SOURCE_ADMIN_REQUIRED','An administrator must approve a source mapping',403);
  await requireRecordLocation(tx,current,s.locationId);await requireRecordAccess(tx,current,proofId,true);
  const location=(await tx.query<{location_id:string|null}>('SELECT location_id FROM record_state WHERE proof_id=$1',[proofId])).rows[0]?.location_id??null;
  if(location!==s.locationId)fail('SOURCE_LOCATION_MISMATCH','The target record must have exactly the approved source location');
  if(!(await tx.query('SELECT 1 FROM platform_integration_accounts WHERE id=$1 AND merchant_id=$2 AND environment=$3',[s.connectionId,w.organizationId,w.environment])).rows[0])fail('CONNECTION_NOT_FOUND','Source connection not found',404);
  const result=await idempotent(tx,clock,w.tenantId,`source-crosswalk:${w.organizationId}:${w.environment}:${w.userId}`,key,input,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${w.organizationId}:${s.connectionId}`]);
   const params=[w.organizationId,w.environment,s.connectionId,s.locationId??'',s.reference.type,s.reference.externalId];
   const old=(await tx.query<{proof_id:string}>('SELECT proof_id FROM record_source_crosswalks WHERE organization_id=$1 AND environment=$2 AND connection_id=$3 AND location_key=$4 AND reference_type=$5 AND external_id=$6',params)).rows[0];
   if(old&&old.proof_id!==proofId)fail('SOURCE_CROSSWALK_CONFLICT','An approved reference cannot be silently reassigned to another shipment');
   if(old)return {proofId,alreadyLinked:true};
   const id=newId('crosswalk'),at=clock.now().toISOString();
   await tx.query('INSERT INTO record_source_crosswalks(id,organization_id,environment,connection_id,location_id,location_key,reference_type,external_id,proof_id,rule_version,approved_by,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[id,w.organizationId,w.environment,s.connectionId,s.locationId,s.locationId??'',s.reference.type,s.reference.externalId,proofId,ruleVersion,w.userId,reason,at]);
   // Establish an explicit immutable connection binding before using the old
   // event/artifact paths; their existing binding requirement remains unchanged.
   await tx.query("INSERT INTO platform_external_bindings(merchant_id,environment,integration_account_id,resource_type,external_id,proof_id,snapshot_sha256,created_at) VALUES($1,$2,$3,'SHIPMENT',$4,$5,$6,$7)",[w.organizationId,w.environment,s.connectionId,`crosswalk:${id}`,proofId,sha256Hex(canonicalize({id,proofId,ruleVersion,reference:s.reference})),at]);
   await tx.query("UPDATE record_source_pending SET state='pending',next_attempt_at=$4,error_code=NULL WHERE organization_id=$1 AND environment=$2 AND connection_id=$3 AND location_key=$5 AND state IN ('pending','blocked_policy','retryable_error') AND normalized->'reference'=$6::jsonb",[w.organizationId,w.environment,s.connectionId,at,s.locationId??'',JSON.stringify(s.reference)]);
   await auditOrganization(tx,clock,{userId:w.userId,merchantId:w.organizationId,requestId:id,operation:'SOURCE_CROSSWALK_APPROVED',resourceId:id});
   return {id,proofId,alreadyLinked:false};
  });return result;
 });
}
export async function replaySourceAssociation(db:Database,clock:Clock,w:RecordWorkspace,id:string,input:unknown,key:unknown) {
 if(w.partner)fail('SOURCE_ADMIN_REQUIRED','Source replay requires a current human administrator session',403);
 const body=strictBody(input,['organizationId','environment','reason']),reason=textField(body.reason,'reason',1000);
 return db.transaction(async tx=>{
  const current=await requireRecordWorkspace(tx,w.userId,w.organizationId,w.environment,true);
  if(!['OWNER','ADMIN'].includes(current.role))fail('SOURCE_ADMIN_REQUIRED','An administrator must request source replay',403);
  const row=(await tx.query<Pending>('SELECT * FROM record_source_pending WHERE id=$1 AND organization_id=$2 AND environment=$3',[id,current.organizationId,current.environment])).rows[0];
  if(!row)fail('OPERATION_NOT_FOUND','Source association not found',404);
  await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${row.organization_id}:${row.connection_id}`]);
  await tx.query('SELECT id FROM record_source_pending WHERE id=$1 FOR UPDATE',[id]);
  await requireRecordLocation(tx,current,row.location_id);
  for(const proof of row.resolution.candidates as string[]??[])await requireRecordAccess(tx,current,proof,true);
  const revision=await connection(tx,clock,row.actor_context,row.connection_id,row.location_id);
  return idempotent(tx,clock,current.tenantId,`source-replay:${current.environment}:${current.userId}:${id}`,key,body,async tx=>{
   const latest=(await tx.query<Pending>('SELECT * FROM record_source_pending WHERE id=$1',[id])).rows[0];
   if(latest.operation_id||latest.state==='conflict')fail('SOURCE_REPLAY_UNAVAILABLE','Submitted or conflicting identities cannot be reassigned by replay');
   await tx.query("UPDATE record_source_pending SET state='pending',next_attempt_at=$2,updated_at=$2,error_code=NULL,replay_revision=$3 WHERE id=$1",[id,clock.now().toISOString(),revision]);
   await auditOrganization(tx,clock,{userId:current.userId,merchantId:current.organizationId,requestId:newId('req'),operation:'SOURCE_REPLAY_REQUESTED',resourceId:id});
   // Keep the administrator's reason in append-only history, separate from
   // original source attribution and every automatic matching attempt.
   await tx.query('INSERT INTO record_source_resolution_attempts(id,pending_id,outcome,created_at) VALUES($1,$2,$3::jsonb,$4)',[newId('resolution'),id,JSON.stringify({action:'replay_requested',actorUserId:current.userId,reason}),clock.now().toISOString()]);
   return {id,state:'pending'};
  });
 });
}
