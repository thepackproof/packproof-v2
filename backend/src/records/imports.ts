import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { createTransaction } from '../domain/transactions.js';
import { createOrGetProof } from '../domain/create-proof.js';
import { appendAudit } from '../domain/audit.js';
import { auditOrganization } from '../platform/organizations.js';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { newId } from '../ids.js';
import { requireRecordWorkspace, requireRecordLocation, requireRecordAccess } from './access.js';
import { parseShipmentCsv, correctionCsv, type ShipmentCsvRow, type CsvMapping } from './csv.js';

const MAPPING_VERSION = 'packproof.csv-mapping/v1';
type ImportDependencies = Pick<AppDependencies,'db'|'clock'|'objectStore'|'devAuth'>;
type JobState = 'previewed'|'queued'|'running'|'succeeded'|'partially_succeeded'|'failed'|'action_needed';
interface JobRow {
 id:string;organization_id:string;environment:'sandbox'|'live';created_by:string;committed_by:string|null;source_name:string;integration_account_id:string;
 preview_version:string;mapping_version:string;mapping:CsvMapping;headers:string[];delimiter:','|';'|'\t';time_zone:string;
 original_object_key:string;original_version_id:string|null;original_sha256:string;original_byte_size:number;state:JobState;
 import_valid_rows:boolean;received_at:Date|string;updated_at:Date|string;lease_token:string|null;lease_expires_at:Date|string|null;last_error_code:string|null;
}
interface RowRecord { row_number:number;status:ShipmentCsvRow['status'];source_values:Record<string,string>;normalized:ShipmentCsvRow['normalized'];payload_sha256:string|null;errors:string[];proof_id:string|null;attempts:number; }
export interface RecordImportView {
 id:string;previewVersion:string;state:JobState;organizationId:string;environment:'sandbox'|'live';sourceName:string;timeZone:string;mappingVersion:string;mapping:CsvMapping;headers:string[];delimiter:string;encoding:'UTF-8';receivedAt:string;updatedAt:string;
 original:{sha256:string;byteSize:number;versionBound:boolean};counts:Record<ShipmentCsvRow['status'],number>;rows:ShipmentCsvRow[];correctionsCsv:string;recordIds:string[];lastErrorCode:string|null;
 syncStatus:'not_applicable';message:string;
}
const iso = (date:Date|string) => new Date(date).toISOString();
const toRow = (row:RowRecord):ShipmentCsvRow => ({rowNumber:row.row_number,status:row.status,values:row.source_values,errors:row.errors,normalized:row.normalized,payloadSha256:row.payload_sha256,...(row.proof_id?{proofId:row.proof_id}:{})});
function object(input:unknown):Record<string,unknown> { if(!input || typeof input!=='object'||Array.isArray(input))throw new DomainError('INVALID_REQUEST','Supply the spreadsheet setup fields.',400);return input as Record<string,unknown>; }
function sourceName(value:unknown) { if(value===undefined)return 'Spreadsheet';if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw new DomainError('INVALID_SOURCE_NAME','Use a source name of at most 80 characters.',400);return value.trim(); }
async function getJob(db:Database,id:string,lock=false) { const row=(await db.query<JobRow>(`SELECT * FROM record_import_jobs WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];if(!row)throw new DomainError('IMPORT_NOT_FOUND','Import not found.',404);return row; }
async function getRows(db:Database,id:string) {return (await db.query<RowRecord>('SELECT * FROM record_import_rows WHERE import_id=$1 ORDER BY row_number',[id])).rows.map(toRow);}
async function authorizeJob(db:Database,userId:string,job:JobRow,write=false) {
 const workspace=await requireRecordWorkspace(db,userId,job.organization_id,job.environment,write);
 if(workspace.role==='OPERATOR'&&job.created_by!==userId&&job.committed_by!==userId)throw new DomainError('IMPORT_NOT_FOUND','Import not found.',404);
 // An import may contain multiple locations. A partial location grant must never
 // expose the original rows or counts of locations outside that current grant.
 const locations=new Set((await getRows(db,job.id)).flatMap(row=>row.normalized?[row.normalized.locationId]:[]));
 for(const location of locations)await requireRecordLocation(db,workspace,location);
 return workspace;
}
function view(job:JobRow,rows:ShipmentCsvRow[]):RecordImportView {
 const counts={valid:0,invalid:0,duplicate:0,ambiguous:0,imported:0,failed:0};for(const row of rows)counts[row.status]++;
 return {id:job.id,previewVersion:job.preview_version,state:job.state,organizationId:job.organization_id,environment:job.environment,sourceName:job.source_name,timeZone:job.time_zone,mappingVersion:job.mapping_version,mapping:job.mapping,headers:job.headers,delimiter:job.delimiter,encoding:'UTF-8',receivedAt:iso(job.received_at),updatedAt:iso(job.updated_at),original:{sha256:job.original_sha256,byteSize:job.original_byte_size,versionBound:!!job.original_version_id&&job.original_version_id!=='null'},counts,rows,correctionsCsv:correctionCsv(job.headers,rows),recordIds:[...new Set(rows.flatMap(row=>row.proofId?[row.proofId]:[]))],lastErrorCode:job.last_error_code,syncStatus:'not_applicable',message:job.state==='succeeded'?'Import complete — view records. This spreadsheet is a one-time import.':job.state==='previewed'?'Review the rows and mapping before importing.':job.state==='queued'||job.state==='running'?'The import has a durable receipt and is processing.':'Review the highlighted rows. Accepted records are preserved.'};
}
export async function readRecordImport(db:Database,userId:string,id:string):Promise<RecordImportView>{
 const job=await getJob(db,id);await authorizeJob(db,userId,job);const result=view(job,await getRows(db,id));await requireRecordWorkspace(db,userId,job.organization_id,job.environment);return result;
}

/** Bytes are preserved and server-hashed before the receipt is acknowledged. */
export async function previewRecordImport(deps:ImportDependencies,userId:string,input:unknown):Promise<RecordImportView>{
 const b=object(input);if(Object.keys(b).some(key=>!['organizationId','environment','csv','mapping','timeZone','sourceName'].includes(key)))throw new DomainError('INVALID_REQUEST','Only documented spreadsheet setup fields are accepted.',400);
 const workspace=await requireRecordWorkspace(deps.db,userId,b.organizationId,b.environment,true);
 const parsed=parseShipmentCsv(b.csv,b.mapping,b.timeZone),name=sourceName(b.sourceName),id=newId('import');
 for(const row of parsed.rows)if(row.normalized){try{await requireRecordLocation(deps.db,workspace,row.normalized.locationId);}catch{row.status='invalid';row.errors.push(`Row ${row.rowNumber} needs a location you are currently authorized to import.`);row.normalized=null;}}
 let accountId=`csv_${sha256Hex(canonicalize({organizationId:workspace.organizationId,environment:workspace.environment,sourceName:name}))}`;
 const bytes=Buffer.from(b.csv as string,'utf8'),digest=sha256Hex(bytes),objectKey=`evidence/${workspace.organizationId}/${id}/committed/sha256-${digest}`;
 if(deps.objectStore.putIfAbsent)await deps.objectStore.putIfAbsent(objectKey,bytes,'text/csv; charset=utf-8');else await deps.objectStore.put(objectKey,bytes,'text/csv; charset=utf-8');
 const stored=await deps.objectStore.digest(objectKey);
 if(!stored||stored.sha256!==digest||stored.byteSize!==bytes.length)throw new DomainError('IMPORT_ORIGINAL_UNVERIFIED','The original spreadsheet could not be preserved. Retry the upload.',503);
 if((!stored.versionId||stored.versionId==='null')&&!deps.devAuth)throw new DomainError('IMPORT_STORAGE_VERSION_UNAVAILABLE','Version-bound import storage is not configured. Your administrator needs to enable it before accepting spreadsheets.',503);
 const version=sha256Hex(canonicalize({schema:MAPPING_VERSION,sha256:digest,mapping:parsed.mapping,timeZone:parsed.timeZone,sourceName:name})),now=deps.clock.now().toISOString();
 await deps.db.transaction(async tx=>{
  await requireRecordWorkspace(tx,userId,workspace.organizationId,workspace.environment,true);
  await tx.query('INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[accountId,workspace.organizationId,workspace.environment,'csv',`${workspace.organizationId}:${name}`,now]);
  const source=(await tx.query<{id:string}>("SELECT id FROM platform_integration_accounts WHERE merchant_id=$1 AND environment=$2 AND provider='csv' AND external_account_id=$3",[workspace.organizationId,workspace.environment,`${workspace.organizationId}:${name}`])).rows[0];
  if(!source)throw new DomainError('IMPORT_SOURCE_NAMESPACE_CONFLICT','This spreadsheet source cannot be used. Ask a workspace administrator to review its connection namespace.',409);accountId=source.id;
  for(const row of parsed.rows)if(row.normalized&&row.status==='valid'){
   const old=(await tx.query<{proof_id:string;snapshot_sha256:string}>("SELECT proof_id,snapshot_sha256 FROM platform_external_bindings WHERE merchant_id=$1 AND environment=$2 AND integration_account_id=$3 AND resource_type='SHIPMENT' AND external_id=$4",[workspace.organizationId,workspace.environment,accountId,row.normalized.shipmentReference])).rows[0];
   if(old){
    try{await requireRecordAccess(tx,workspace,old.proof_id);}catch{row.status='invalid';row.errors.push('This source reference cannot be imported with your current record permissions. Ask a workspace administrator to review it.');continue;}
    row.status=old.snapshot_sha256===row.payloadSha256?'duplicate':'ambiguous';if(row.status==='duplicate')row.proofId=old.proof_id;row.errors.push(row.status==='duplicate'?'This shipment was already imported from this source.':'This source reference is already linked to different details. Review the existing record and append a correction.');
   }
  }
  await tx.query(`INSERT INTO record_import_jobs(id,organization_id,environment,created_by,source_name,integration_account_id,preview_version,mapping_version,mapping,headers,delimiter,time_zone,original_object_key,original_version_id,original_sha256,original_byte_size,state,received_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,'previewed',$17,$17)`,[id,workspace.organizationId,workspace.environment,userId,name,accountId,version,MAPPING_VERSION,JSON.stringify(parsed.mapping),JSON.stringify(parsed.headers),parsed.delimiter,parsed.timeZone,objectKey,stored.versionId??null,digest,bytes.length,now]);
  for(const row of parsed.rows)await tx.query('INSERT INTO record_import_rows(import_id,row_number,status,source_values,normalized,payload_sha256,errors,proof_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8)',[id,row.rowNumber,row.status,JSON.stringify(row.values),JSON.stringify(row.normalized),row.payloadSha256,JSON.stringify(row.errors),row.proofId??null]);
  await auditOrganization(tx,deps.clock,{userId,merchantId:workspace.organizationId,requestId:id,operation:'CSV_IMPORT_PREVIEWED',resourceId:id});
 });
 return readRecordImport(deps.db,userId,id);
}
export async function commitRecordImport(db:Database,clock:Clock,userId:string,id:string,input:unknown):Promise<RecordImportView>{
 const b=object(input);if(Object.keys(b).some(key=>!['previewVersion','importValidRows'].includes(key))||typeof b.previewVersion!=='string'||typeof b.importValidRows!=='boolean')throw new DomainError('INVALID_REQUEST','Confirm the preview version and whether to import valid rows while leaving errors unresolved.',400);
 await db.transaction(async tx=>{
  const job=await getJob(tx,id,true);await authorizeJob(tx,userId,job,true);
  if(b.previewVersion!==job.preview_version)throw new DomainError('IMPORT_PREVIEW_CHANGED','Review the current spreadsheet preview before importing.',409);
  if(['queued','running','succeeded'].includes(job.state))return;
  const rows=await getRows(tx,id);
  if(!b.importValidRows&&rows.some(row=>['invalid','ambiguous','failed'].includes(row.status)))throw new DomainError('IMPORT_HAS_ROW_ERRORS','Fix the highlighted rows or explicitly choose to import the valid rows.',409);
  if(!rows.some(row=>row.status==='valid'||row.status==='failed')&&rows.some(row=>['invalid','ambiguous'].includes(row.status)))throw new DomainError('IMPORT_NO_VALID_ROWS','Correct the highlighted rows and upload a new preview.',409);
  await tx.query("UPDATE record_import_rows SET status='valid',errors='[]'::jsonb WHERE import_id=$1 AND status='failed' AND normalized IS NOT NULL AND attempts<5",[id]);
  await tx.query("UPDATE record_import_jobs SET committed_by=$2,state='queued',import_valid_rows=$3,updated_at=$4,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=$1",[id,userId,b.importValidRows,clock.now().toISOString()]);
  await auditOrganization(tx,clock,{userId,merchantId:job.organization_id,requestId:id,operation:'CSV_IMPORT_COMMITTED',resourceId:id});
 });
 return readRecordImport(db,userId,id);
}

async function importRow(db:Database,clock:Clock,job:JobRow,rowNumber:number,lease:string){
 await db.transaction(async tx=>{
  const current=await getJob(tx,job.id,true);assertImportLease(current,lease,clock);
  const row=(await tx.query<RowRecord>('SELECT * FROM record_import_rows WHERE import_id=$1 AND row_number=$2 FOR UPDATE',[job.id,rowNumber])).rows[0];if(!row||row.status!=='valid'||!row.normalized)return;
  const user=job.committed_by!,workspace=await requireRecordWorkspace(tx,user,job.organization_id,job.environment,true),n=row.normalized;
  await requireRecordLocation(tx,workspace,n.locationId);
  await tx.query('SELECT pg_advisory_xact_lock(1347438147,hashtext($1))',[job.organization_id]);
  const old=(await tx.query<{proof_id:string;snapshot_sha256:string}>("SELECT proof_id,snapshot_sha256 FROM platform_external_bindings WHERE merchant_id=$1 AND environment=$2 AND integration_account_id=$3 AND resource_type='SHIPMENT' AND external_id=$4",[job.organization_id,job.environment,job.integration_account_id,n.shipmentReference])).rows[0];
  if(old){
   await requireRecordAccess(tx,workspace,old.proof_id);
   if(old.snapshot_sha256!==row.payload_sha256)throw new DomainError('SOURCE_REFERENCE_CONFLICT','This source reference already has different immutable details. Review the existing record and append a correction.',409);
   assertImportLease(current,lease,clock);
   await tx.query("UPDATE record_import_rows SET status='duplicate',proof_id=$3,errors='[]'::jsonb WHERE import_id=$1 AND row_number=$2",[job.id,rowNumber,old.proof_id]);return;
  }
  const transaction=await createTransaction(tx,clock,user,{itemTitle:n.itemTitle,quantity:n.quantity,shipping:{carrier:n.carrier,trackingNumber:n.trackingNumber,shipmentDate:n.shipmentDate},metadata:{source:'csv_import',organizationId:job.organization_id,environment:job.environment,importId:job.id,sourceName:job.source_name,sourceReference:n.shipmentReference,sourceReportedAt:n.shippedAt,sourceTimeZone:job.time_zone,sourcePayloadSha256:row.payload_sha256,originalSha256:job.original_sha256,mappingVersion:job.mapping_version}});
  const proof=await createOrGetProof(tx,clock,user,transaction.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL'}),now=clock.now().toISOString();
  await tx.query('INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_principal_id,origin_user_id,created_at) VALUES($1,$2,$3,$4,NULL,$5,$6)',[proof.proofId,job.organization_id,job.environment,workspace.membershipId,user,now]);
  await tx.query("INSERT INTO platform_external_bindings(merchant_id,environment,integration_account_id,resource_type,external_id,proof_id,snapshot_sha256,created_at) VALUES($1,$2,$3,'SHIPMENT',$4,$5,$6,$7)",[job.organization_id,job.environment,job.integration_account_id,n.shipmentReference,proof.proofId,row.payload_sha256,now]);
  await tx.query('INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,$2,$3,$4,$5)',[workspace.tenantId,`csv:${sha256Hex(canonicalize({account:job.integration_account_id,reference:n.shipmentReference}))}`,proof.proofId,row.payload_sha256,now]);
  await tx.query('INSERT INTO record_state(proof_id,organization_id,environment,title,reference,location_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[proof.proofId,job.organization_id,job.environment,n.itemTitle,n.shipmentReference,n.locationId,now]);
  await tx.query("INSERT INTO record_entities(id,proof_id,kind,external_reference,attributes,actor_user_id,created_at) VALUES($1,$2,'shipment',$3,$4::jsonb,$5,$6)",[newId('shipment'),proof.proofId,n.shipmentReference,JSON.stringify({quantity:n.quantity,trackingNumber:n.trackingNumber,carrier:n.carrier,sourceReportedAt:n.shippedAt,sourceTimeZone:job.time_zone,importId:job.id}),user,now]);
  await appendAudit(tx,{proofId:proof.proofId,actorUserId:user,eventType:'CSV_SHIPMENT_IMPORTED',eventData:{importId:job.id,rowNumber,sourceName:job.source_name,sourceReference:n.shipmentReference,originalSha256:job.original_sha256,payloadSha256:row.payload_sha256,sourceReportedAt:n.shippedAt,receivedAt:iso(job.received_at),mappingVersion:job.mapping_version},at:clock.now()});
  await auditOrganization(tx,clock,{userId:user,merchantId:job.organization_id,requestId:job.id,operation:'CSV_ROW_IMPORTED',resourceId:proof.proofId});
  // Row creation and lease renewal share this transaction. If work outlived the
  // lease, roll back the complete row rather than acknowledge a stale writer.
  assertImportLease(current,lease,clock);
  await tx.query("UPDATE record_import_rows SET status='imported',proof_id=$3,attempts=attempts+1,errors='[]'::jsonb WHERE import_id=$1 AND row_number=$2",[job.id,rowNumber,proof.proofId]);
  await tx.query('UPDATE record_import_jobs SET updated_at=$2,lease_expires_at=$3 WHERE id=$1',[job.id,now,new Date(clock.now().getTime()+120000).toISOString()]);
 });
}

function assertImportLease(job:JobRow,lease:string,clock:Clock) {
 const expires=job.lease_expires_at==null?NaN:new Date(job.lease_expires_at).getTime();
 if(job.state!=='running'||job.lease_token!==lease||!Number.isFinite(expires)||expires<=clock.now().getTime())
  throw new DomainError('IMPORT_LEASE_LOST','This import lease expired or was reclaimed by another worker. Accepted rows remain available.',409);
}

/** The inbox is durable and leased; a scanner recovers accepted jobs after crashes. */
export async function processPendingRecordImports(deps:ImportDependencies,limit=2):Promise<{processed:number;failed:number}>{
 let processed=0,failed=0;
 for(let count=0;count<Math.max(1,Math.min(10,limit));count++){
  const lease=newId('import_lease');
  const job=await deps.db.transaction(async tx=>{
   const found=(await tx.query<JobRow>("SELECT * FROM record_import_jobs WHERE state='queued' OR (state='running' AND lease_expires_at<$1) ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",[deps.clock.now().toISOString()])).rows[0];if(!found)return null;
   await tx.query("UPDATE record_import_jobs SET state='running',lease_token=$2,lease_expires_at=$3,updated_at=$4 WHERE id=$1",[found.id,lease,new Date(deps.clock.now().getTime()+120000).toISOString(),deps.clock.now().toISOString()]);return found;
  });
  if(!job)break;
  try{
   const stored=await deps.objectStore.digest(job.original_object_key,{versionId:job.original_version_id});
   // Digest verification is external I/O and can outlive the accepted lease.
   // Recheck its current deadline before consuming rows, including empty jobs.
   await deps.db.transaction(async tx=>{assertImportLease(await getJob(tx,job.id,true),lease,deps.clock);});
   if(!stored||stored.sha256!==job.original_sha256||stored.byteSize!==job.original_byte_size)throw new DomainError('IMPORT_ORIGINAL_INTEGRITY_FAILED','The preserved spreadsheet is unavailable or changed. Contact support with this import receipt.',409);
   for(const row of await getRows(deps.db,job.id))if(row.status==='valid'){
    try{await importRow(deps.db,deps.clock,job,row.rowNumber,lease);}
    catch(error){
     if(error instanceof DomainError && error.code==='IMPORT_LEASE_LOST')throw error;
     const message=error instanceof DomainError?error.message:'This row could not be processed. Retry failed rows using the same import receipt.';
     await deps.db.transaction(async tx=>{const current=await getJob(tx,job.id,true);assertImportLease(current,lease,deps.clock);await tx.query("UPDATE record_import_rows SET status='failed',attempts=attempts+1,errors=$3::jsonb WHERE import_id=$1 AND row_number=$2 AND status='valid'",[job.id,row.rowNumber,JSON.stringify([message])]);});
    }
   }
   await deps.db.transaction(async tx=>{
    const current=await getJob(tx,job.id,true);assertImportLease(current,lease,deps.clock);
    await requireRecordWorkspace(tx,job.committed_by!,job.organization_id,job.environment,true);
    const rows=await getRows(tx,job.id),errors=rows.some(row=>['invalid','ambiguous','failed'].includes(row.status)),success=rows.some(row=>['imported','duplicate'].includes(row.status));
    const state=errors?(success?'partially_succeeded':'failed'):'succeeded';
    await tx.query('UPDATE record_import_jobs SET state=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=$3 WHERE id=$1',[job.id,state,deps.clock.now().toISOString()]);
    await auditOrganization(tx,deps.clock,{userId:job.committed_by!,merchantId:job.organization_id,requestId:job.id,operation:'CSV_IMPORT_COMPLETED',resourceId:job.id});
   });processed++;
  }catch(error){
   if(error instanceof DomainError&&error.code==='IMPORT_LEASE_LOST')continue;
   await deps.db.query("UPDATE record_import_jobs SET state='action_needed',last_error_code=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=$4 WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_expires_at>$4",[job.id,lease,error instanceof DomainError?error.code:'IMPORT_WORKER_FAILED',deps.clock.now().toISOString()]);failed++;
  }
 }
 return {processed,failed};
}
export function startRecordImportWorker(deps:ImportDependencies){
 let active:Promise<unknown>|null=null,stopping=false;
 const tick=()=>{if(stopping||active)return;active=processPendingRecordImports(deps).catch(()=>console.error(JSON.stringify({event:'record_import_worker_failed'}))).finally(()=>{active=null;});};
 const timer=setInterval(tick,5000);timer.unref();tick();return async()=>{stopping=true;clearInterval(timer);await active;};
}
