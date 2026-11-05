import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { recordShipmentEvent } from '../domain/shipment-events.js';
import { SHIPMENT_EVENT_TYPES } from '../domain/shipment-event-types.js';
import { appendAudit } from '../domain/audit.js';
import { authorizePartnerProof, reauthorizePartner, auditOrganization, strictBody, type PartnerActor } from '../platform/organizations.js';
import { idempotent } from '../platform/idempotency.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { requireRecordAccess } from './access.js';

export const SOURCE_INGESTION_LIMITS={events:100,requestBytes:256*1024,eventDataBytes:8192} as const;
export interface SourceObservation {sourceEventId:string;proofId:string;eventType:string;reportedAt:string;carrier:string|null;location:string|null;data:Record<string,unknown>;}
interface OperationRow {id:string;organization_id:string;environment:'sandbox'|'live';connection_id:string;connection_revision:string|number;principal_id:string;credential_id:string;delegation_id:string|null;actor_context:PartnerActor;request_id:string;received_at:Date|string;state:'queued'|'running'|'succeeded'|'partially_succeeded'|'failed';attempts:number;next_attempt_at:Date|string;updated_at:Date|string;lease_token:string|null;lease_expires_at:Date|string|null;}
interface ReceiptRow {id:string;operation_id:string;item_index:number;organization_id:string;environment:'sandbox'|'live';connection_id:string;source_event_id:string;proof_id:string;reported_at:Date|string;received_at:Date|string;payload_canonical:string;payload_sha256:string;normalized:SourceObservation;state:'queued'|'imported'|'duplicate'|'conflict'|'failed';canonical_event_id:string|null;duplicate_of:string|null;error_code:string|null;attempts:number;}
const iso=(value:Date|string)=>new Date(value).toISOString();
function text(value:unknown,field:string,max=200):string{if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new DomainError('INVALID_INGESTION',`${field} must contain 1 to ${max} characters`,400);return value.trim();}
const SECRET=/authorization|access.?token|refresh.?token|api.?key|client.?secret|password|credential|cookie|signed.?url|launch.?token|private.?key|^(?:secret|token|bearer)$/i;
function validateData(value:unknown,depth=0):void {
 if(depth>6)throw new DomainError('INVALID_INGESTION','Event data may contain at most six nested levels',400);
 if(Array.isArray(value)){if(value.length>100)throw new DomainError('INVALID_INGESTION','Event data arrays may contain at most 100 values',400);for(const item of value)validateData(item,depth+1);return;}
 if(value&&typeof value==='object'){const entries=Object.entries(value);if(entries.length>100)throw new DomainError('INVALID_INGESTION','Event data objects may contain at most 100 fields',400);for(const [key,item]of entries){if(SECRET.test(key)||key.startsWith('_packproof'))throw new DomainError('INGESTION_SECRET_FIELD','Event data cannot contain credentials, signed URLs or reserved PackProof fields',400);validateData(item,depth+1);}return;}
 if(typeof value==='string'&&value.length>2000)throw new DomainError('INVALID_INGESTION','Event data strings may contain at most 2,000 characters',400);
 if(typeof value==='string'&&(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)||/\bpp_org_(?:live|sandbox)_[A-Za-z0-9_-]{43}\b/.test(value)||/https?:\/\/\S*[?&](?:X-Amz-Signature|token|api[_-]?key|sig|signature)=/i.test(value)))throw new DomainError('INGESTION_SECRET_FIELD','Event data cannot contain private keys, API credentials or signed access URLs',400);
 if(value!==null&&!['string','number','boolean'].includes(typeof value))throw new DomainError('INVALID_INGESTION','Event data must contain JSON values only',400);
 if(typeof value==='number'&&!Number.isFinite(value))throw new DomainError('INVALID_INGESTION','Event data numbers must be finite',400);
}
export function parseSourceIngestion(input:unknown){
 const b=strictBody(input,['connectionId','events']),connectionId=text(b.connectionId,'connectionId');
 let encoded:string;try{encoded=canonicalize(b);}catch{throw new DomainError('INVALID_INGESTION','Use a bounded JSON source event payload',400);}
 if(Buffer.byteLength(encoded)>SOURCE_INGESTION_LIMITS.requestBytes)throw new DomainError('INGESTION_TOO_LARGE','Use at most 256 KiB per ingestion',413);
 if(!Array.isArray(b.events)||!b.events.length||b.events.length>SOURCE_INGESTION_LIMITS.events)throw new DomainError('INVALID_INGESTION','Supply 1 to 100 normalized events',400);
 const events=b.events.map((input,index):SourceObservation=>{
  const item=strictBody(input,['sourceEventId','proofId','eventType','reportedAt','carrier','location','data']);
  const sourceEventId=text(item.sourceEventId,`events[${index}].sourceEventId`),proofId=text(item.proofId,`events[${index}].proofId`),eventType=text(item.eventType,`events[${index}].eventType`,100);
  if(!(SHIPMENT_EVENT_TYPES as readonly string[]).includes(eventType))throw new DomainError('INVALID_INGESTION','Use a documented canonical shipment eventType',400);
  const reportedAt=text(item.reportedAt,`events[${index}].reportedAt`,64);
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(reportedAt)||!Number.isFinite(Date.parse(reportedAt))||new Date(`${reportedAt.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)!==reportedAt.slice(0,10))throw new DomainError('INVALID_INGESTION','reportedAt must be a valid ISO timestamp with an explicit UTC offset',400);
  const data=item.data??{};if(!data||typeof data!=='object'||Array.isArray(data))throw new DomainError('INVALID_INGESTION','Event data must be a JSON object',400);validateData(data);
  if(Buffer.byteLength(canonicalize({...data,_packproofSource:{type:'organization_submitted',connectionId,receivedAt:'2000-01-01T00:00:00.000Z'}}))>SOURCE_INGESTION_LIMITS.eventDataBytes)throw new DomainError('INGESTION_TOO_LARGE','Event data and source metadata must fit within 8 KiB',413);
  return {sourceEventId,proofId,eventType,reportedAt,carrier:item.carrier==null?null:text(item.carrier,'carrier'),location:item.location==null?null:text(item.location,'location'),data:data as Record<string,unknown>};
 });
 return {connectionId,events,payloads:b.events.map(event=>canonicalize(event))};
}
async function connection(db:Database,actor:PartnerActor,id:string){
 const row=(await db.query<{paused:boolean|null;control_revision:string|number|null}>('SELECT s.paused,s.control_revision FROM platform_integration_accounts a LEFT JOIN record_connection_state s ON s.connection_id=a.id WHERE a.id=$1 AND a.merchant_id=$2 AND a.environment=$3',[id,actor.merchantId,actor.environment])).rows[0];
 if(!row)throw new DomainError('CONNECTION_NOT_FOUND','Source connection not found',404);
 if(row.paused)throw new DomainError('CONNECTION_PAUSED','This source connection is paused',409);
 return row.control_revision??0;
}
async function eventAccess(db:Database,clock:Clock,actor:PartnerActor,id:string,proofId:string,lockState=false){
 if(lockState){
  await authorizePartnerProof(db,clock,actor,proofId,'proofs:write');
  await db.query('INSERT INTO record_state(proof_id,organization_id,environment,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[proofId,actor.merchantId,actor.environment,clock.now().toISOString()]);
  await db.query('SELECT proof_id FROM record_state WHERE proof_id=$1 FOR UPDATE',[proofId]);
 }
 await requireRecordAccess(db,{organizationId:actor.merchantId,environment:actor.environment,tenantId:actor.tenantId,membershipId:'',userId:actor.actorUserId,role:'OPERATOR',enabled:true,locationScoped:false,partner:actor,authorizationClock:clock},proofId,true);
 if(!(await db.query('SELECT 1 FROM platform_external_bindings WHERE proof_id=$1 AND merchant_id=$2 AND environment=$3 AND integration_account_id=$4',[proofId,actor.merchantId,actor.environment,id])).rows[0])throw new DomainError('SOURCE_PROOF_NOT_BOUND','The authorized record is not bound to this source connection',409);
}
function receipt(row:OperationRow){return {operationId:row.id,state:row.state,receivedAt:iso(row.received_at),links:{self:`/v1/partner/operations/${row.id}`}};}
export async function acceptSourceIngestion(db:Database,clock:Clock,actor:PartnerActor,input:unknown,key:unknown){
 const parsed=parseSourceIngestion(input);await reauthorizePartner(db,clock,actor,'proofs:write');await connection(db,actor,parsed.connectionId);
 const proofIds=[...new Set(parsed.events.map(event=>event.proofId))].sort();
 // A cache hit bypasses its mutation callback, so current record/location policy
 // must surround the idempotency lookup as well as guard the transaction itself.
 for(const proofId of proofIds)await eventAccess(db,clock,actor,parsed.connectionId,proofId);
 const operation=`source-ingestion:${actor.environment}:${actor.principalId}:${actor.credentialId}:${actor.delegationGrantId??'direct'}`;
 const result=await idempotent(db,clock,actor.tenantId,operation,key,input,async tx=>{
  await reauthorizePartner(tx,clock,actor,'proofs:write');
  await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${actor.merchantId}:${parsed.connectionId}`]);
  const connectionRevision=await connection(tx,actor,parsed.connectionId);
  for(const proofId of proofIds)await eventAccess(tx,clock,actor,parsed.connectionId,proofId,true);
  await tx.query('SELECT pg_advisory_xact_lock(1347438150,hashtext($1))',[`${actor.merchantId}:${actor.environment}:${parsed.connectionId}`]);
  const id=newId('ingestion'),now=clock.now().toISOString(),savedActor={...actor,requestId:id};
  await tx.query("INSERT INTO record_ingestion_operations(id,organization_id,environment,connection_id,connection_revision,principal_id,credential_id,delegation_id,actor_context,request_id,received_at,state,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'queued',$11,$11)",[id,actor.merchantId,actor.environment,parsed.connectionId,connectionRevision,actor.principalId,actor.credentialId,actor.delegationGrantId,JSON.stringify(savedActor),actor.requestId,now]);
  let queued=0;
  for(const [index,event]of parsed.events.entries()){
   const payload=parsed.payloads[index],hash=sha256Hex(payload),receiptId=newId('source_receipt');
   const old=(await tx.query<{receipt_id:string;payload_sha256:string;proof_id:string}>('SELECT i.receipt_id,i.payload_sha256,r.proof_id FROM record_source_identities i JOIN record_source_receipts r ON r.id=i.receipt_id WHERE i.organization_id=$1 AND i.environment=$2 AND i.connection_id=$3 AND i.source_event_id=$4',[actor.merchantId,actor.environment,parsed.connectionId,event.sourceEventId])).rows[0];
   const conflict=!!old&&old.payload_sha256!==hash;
   await tx.query('INSERT INTO record_source_receipts(id,operation_id,item_index,organization_id,environment,connection_id,source_event_id,proof_id,reported_at,received_at,payload_canonical,payload_sha256,normalized,state,duplicate_of,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)',[receiptId,id,index,actor.merchantId,actor.environment,parsed.connectionId,event.sourceEventId,event.proofId,new Date(event.reportedAt).toISOString(),now,payload,hash,JSON.stringify(event),conflict?'conflict':'queued',old?.receipt_id??null,conflict?'SOURCE_EVENT_CONFLICT':null]);
   if(!old)await tx.query('INSERT INTO record_source_identities(organization_id,environment,connection_id,source_event_id,receipt_id,payload_sha256) VALUES($1,$2,$3,$4,$5,$6)',[actor.merchantId,actor.environment,parsed.connectionId,event.sourceEventId,receiptId,hash]);
   if(conflict){
    // A reused source identity may point at another record whose location or
    // access changed. Retain its receipt internally without revealing its hash
    // or correlation identifier through the newly submitted record.
    const sameRecord=old!.proof_id===event.proofId,original=sameRecord?{receiptId:old!.receipt_id,sha256:old!.payload_sha256}:{visibility:'restricted_to_original_record'};
    await tx.query("INSERT INTO record_issues(id,proof_id,category,severity,title,subject_id,rule_version,compared_sources,created_at) VALUES($1,$2,'source_conflict','warning','Source event ID reused with different details',$2,'packproof.source-identity/v1',$3::jsonb,$4) ON CONFLICT DO NOTHING",[`source_conflict_${sha256Hex(canonicalize({connection:parsed.connectionId,eventId:event.sourceEventId,hash,proofId:event.proofId}))}`,event.proofId,JSON.stringify([original,{receiptId,sha256:hash}]),now]);
    const auditId=await appendAudit(tx,{proofId:event.proofId,actorUserId:actor.actorUserId,eventType:'SOURCE_EVENT_CONFLICT',eventData:{operationId:id,connectionId:parsed.connectionId,sourceEventId:event.sourceEventId,...(sameRecord?{originalSha256:old!.payload_sha256}:{}),receivedSha256:hash},at:clock.now()});
    await tx.query('INSERT INTO proof_outbox(id,proof_id,audit_id,event_type,created_at) VALUES($1,$2,$3,$4,$5)',[`${auditId}:issue.updated`,event.proofId,auditId,'issue.updated',now]);
    await tx.query('INSERT INTO record_state(proof_id,organization_id,environment,revision,updated_at) VALUES($1,$2,$3,2,$4) ON CONFLICT(proof_id) DO UPDATE SET revision=record_state.revision+1,updated_at=EXCLUDED.updated_at',[event.proofId,actor.merchantId,actor.environment,now]);
   }else queued++;
  }
  if(!queued)await tx.query("UPDATE record_ingestion_operations SET state='failed' WHERE id=$1",[id]);
  await auditOrganization(tx,clock,{actor,requestId:id,operation:'SOURCE_INGESTION_ACCEPTED',resourceId:id});
  return {operationId:id,state:queued?'queued':'failed',receivedAt:now,itemCount:parsed.events.length,links:{self:`/v1/partner/operations/${id}`},sourceAssurance:'organization_submitted'};
 });
 await reauthorizePartner(db,clock,actor,'proofs:write');
 for(const proofId of proofIds)await eventAccess(db,clock,actor,parsed.connectionId,proofId);
 return {...result.value,replayed:result.replayed};
}
export async function readSourceOperation(db:Database,clock:Clock,actor:PartnerActor,id:string){
 await reauthorizePartner(db,clock,actor,'proofs:write');
 const row=(await db.query<OperationRow>('SELECT * FROM record_ingestion_operations WHERE id=$1 AND organization_id=$2 AND environment=$3 AND principal_id=$4 AND credential_id=$5 AND delegation_id IS NOT DISTINCT FROM $6',[id,actor.merchantId,actor.environment,actor.principalId,actor.credentialId,actor.delegationGrantId])).rows[0];
 if(!row)throw new DomainError('OPERATION_NOT_FOUND','Operation not found',404);
 const rows=(await db.query<ReceiptRow>('SELECT * FROM record_source_receipts WHERE operation_id=$1 ORDER BY item_index',[id])).rows;
 for(const item of rows)await eventAccess(db,clock,actor,row.connection_id,item.proof_id);
 const items=rows.map(item=>({itemIndex:item.item_index,sourceEventId:item.source_event_id,proofId:item.proof_id,reportedAt:iso(item.reported_at),receivedAt:iso(item.received_at),status:item.state,eventId:item.canonical_event_id,errorCode:item.error_code,attempts:item.attempts}));
 await reauthorizePartner(db,clock,actor,'proofs:write');return {...receipt(row),updatedAt:iso(row.updated_at),itemCount:items.length,items,sourceAssurance:'organization_submitted'};
}
function currentLease(row:OperationRow|undefined,lease:string,clock:Clock){if(!row||row.state!=='running'||row.lease_token!==lease||!row.lease_expires_at||new Date(row.lease_expires_at).getTime()<=clock.now().getTime())throw new DomainError('INGESTION_LEASE_LOST','The source ingestion lease expired or was reclaimed',409);}
async function operation(db:Database,id:string){return (await db.query<OperationRow>('SELECT * FROM record_ingestion_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];}
export async function processSourceIngestions(db:Database,clock:Clock,limit=2){
 let processed=0;
 for(let i=0;i<Math.max(1,Math.min(10,limit));i++){
  const lease=newId('source_lease'),now=clock.now();
  const job=await db.transaction(async tx=>{
   const row=(await tx.query<OperationRow>("SELECT * FROM record_ingestion_operations WHERE (state='queued' AND next_attempt_at<=$1) OR (state='running' AND lease_expires_at<=$1) ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",[now.toISOString()])).rows[0];if(!row)return null;
   await tx.query("UPDATE record_ingestion_operations SET state='running',lease_token=$2,lease_expires_at=$3,attempts=attempts+1,updated_at=$4 WHERE id=$1",[row.id,lease,new Date(now.getTime()+120000).toISOString(),now.toISOString()]);return row;
  });if(!job)break;
  const actor=job.actor_context;
  const rows=(await db.query<ReceiptRow>("SELECT * FROM record_source_receipts WHERE operation_id=$1 AND state='queued' ORDER BY item_index",[job.id])).rows;
  for(const item of rows){
   try{
    await db.transaction(async tx=>{
     currentLease(await operation(tx,job.id),lease,clock);await reauthorizePartner(tx,clock,actor,'proofs:write');
     await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${actor.merchantId}:${job.connection_id}`]);
     if(String(await connection(tx,actor,job.connection_id))!==String(job.connection_revision))throw new DomainError('CONNECTION_CHANGED','Source connection settings changed after acceptance. Review the receipt before submitting a new command.',409);
     await eventAccess(tx,clock,actor,job.connection_id,item.proof_id,true);
     const current=(await tx.query<ReceiptRow>('SELECT * FROM record_source_receipts WHERE id=$1 FOR UPDATE',[item.id])).rows[0];if(current.state!=='queued')return;
     if(sha256Hex(current.payload_canonical)!==current.payload_sha256)throw new DomainError('SOURCE_RECEIPT_INTEGRITY_FAILED','The accepted source receipt failed its digest check',409);
     const source=current.normalized;
     const first=(await tx.query<{received_at:Date|string}>('SELECT r.received_at FROM record_source_identities i JOIN record_source_receipts r ON r.id=i.receipt_id WHERE i.organization_id=$1 AND i.environment=$2 AND i.connection_id=$3 AND i.source_event_id=$4',[actor.merchantId,actor.environment,job.connection_id,source.sourceEventId])).rows[0];
     const transaction=(await tx.query<{transaction_id:string}>('SELECT transaction_id FROM proofs WHERE id=$1',[item.proof_id])).rows[0];
     const recorded=await recordShipmentEvent(tx,clock,actor.actorUserId,{transactionId:transaction.transaction_id,eventType:source.eventType,occurredAt:source.reportedAt,carrier:source.carrier,locationText:source.location,source:'PARTICIPANT_SUPPLIED',provider:`organization:${sha256Hex(canonicalize({organization:actor.merchantId,environment:actor.environment,connection:job.connection_id}))}`,sourceEventId:source.sourceEventId,eventData:{...source.data,_packproofSource:{type:'organization_submitted',connectionId:job.connection_id,receivedAt:iso(first.received_at)}},payloadSha256:item.payload_sha256,authority:'PARTICIPANT'},actor);
     const at=clock.now().toISOString();
     if(recorded.created){
      await tx.query('INSERT INTO record_state(proof_id,organization_id,environment,revision,updated_at) VALUES($1,$2,$3,2,$4) ON CONFLICT(proof_id) DO UPDATE SET revision=record_state.revision+1,updated_at=EXCLUDED.updated_at',[item.proof_id,actor.merchantId,actor.environment,at]);
      await auditOrganization(tx,clock,{actor,requestId:job.id,operation:'SOURCE_OBSERVATION_IMPORTED',resourceId:recorded.event.id});
     }
     currentLease(await operation(tx,job.id),lease,clock);await reauthorizePartner(tx,clock,actor,'proofs:write');
     await tx.query('UPDATE record_source_receipts SET state=$2,canonical_event_id=$3,error_code=NULL,attempts=attempts+1 WHERE id=$1',[item.id,recorded.created?'imported':'duplicate',recorded.event.id]);
     await tx.query('UPDATE record_ingestion_operations SET lease_expires_at=$2,updated_at=$3 WHERE id=$1',[job.id,new Date(clock.now().getTime()+120000).toISOString(),at]);
    });
   }catch(error){
    if(error instanceof DomainError&&error.code==='INGESTION_LEASE_LOST')break;
    await db.transaction(async tx=>{
     const current=await operation(tx,job.id);try{currentLease(current,lease,clock);}catch{return;}
     const retry=!(error instanceof DomainError)||error.httpStatus>=500;
     await tx.query('UPDATE record_source_receipts SET state=$2,error_code=$3,attempts=attempts+1 WHERE id=$1 AND state=$4',[item.id,retry&&item.attempts<4?'queued':'failed',error instanceof DomainError&&error.httpStatus<500?error.code:'SOURCE_PROCESSING_UNAVAILABLE','queued']);
    });
   }
  }
  await db.transaction(async tx=>{
   const current=await operation(tx,job.id);try{currentLease(current,lease,clock);}catch{return;}
   const results=(await tx.query<{state:ReceiptRow['state']}>('SELECT state FROM record_source_receipts WHERE operation_id=$1',[job.id])).rows;
   const pending=results.some(row=>row.state==='queued'),failed=results.some(row=>['failed','conflict'].includes(row.state)),succeeded=results.some(row=>['imported','duplicate'].includes(row.state));
   await tx.query('UPDATE record_ingestion_operations SET state=$2,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=$3,updated_at=$4 WHERE id=$1',[job.id,pending?'queued':failed?(succeeded?'partially_succeeded':'failed'):'succeeded',new Date(clock.now().getTime()+Math.min(300000,1000*2**Math.min(8,current!.attempts))).toISOString(),clock.now().toISOString()]);
  });processed++;
 }
 return {processed};
}
