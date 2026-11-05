import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import type {ObjectStore} from '../s3/object-store.js';
import {evidenceObjectKey,committedEvidenceObjectKey} from '../s3/object-key.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {DomainError} from '../domain/errors.js';
import {appendAudit} from '../domain/audit.js';
import {assertHoldAdmissionOpen} from '../domain/retention-policy.js';
import {validateAdmissionMetadata,verifyMediaSignature} from '../domain/media-admission.js';
import {guardAuthorizedStream} from '../domain/authorized-stream.js';
import {streamPreservedObject,readCommittedEvidenceStream} from '../domain/evidence.js';
import {withPartnerReadGrant} from '../platform/proof-read-grant.js';
import {buildProofRecoverySnapshot,enqueueRecoveryEvent} from '../domain/recovery-journal.js';
import {authorizePartnerProof,reauthorizePartner,strictBody,auditOrganization,type PartnerActor} from '../platform/organizations.js';
import {idempotent} from '../platform/idempotency.js';
import {requireRecordAccess,type RecordWorkspace} from './access.js';

export const SOURCE_ARTIFACT_LIMITS={maximumBytes:250_000_000,partSize:5*1024*1024,activeUploads:2,dailyOrganizationBytes:10_000_000_000,reservationMs:7*86400000,leaseMs:120000,ingressLifetimeMs:600000} as const;
export type SourceArtifactActor={kind:'partner';partner:PartnerActor}|{kind:'human';workspace:RecordWorkspace};
interface Artifact {id:string;proof_id:string;organization_id:string;environment:'sandbox'|'live';connection_id:string|null;connection_revision:number|string;source_artifact_id:string;filename:string;content_type:string;declared_byte_size:number|string;expected_sha256:string|null;subject_id:string;reported_at:Date|string;reported_at_original:string;received_at:Date|string;actor_kind:'partner'|'human';actor_user_id:string;principal_id:string|null;credential_id:string|null;delegation_id:string|null;membership_id:string|null;actor_context:SourceArtifactActor;receipt_canonical:string;receipt_sha256:string;}
interface Session {id:string;artifact_id:string;state:'open'|'receiving'|'received'|'complete'|'expired'|'rejected';staging_key:string;staging_version_id:string|null;received_byte_size:number|string|null;received_sha256:string|null;ingress_bytes:number|string;ingress_limit_bytes:number|string;expires_at:Date|string;lease_token:string|null;lease_expires_at:Date|string|null;error_code:string|null;}
interface Part {session_id:string;part_number:number;object_key:string;object_version_id:string;sha256:string;byte_size:number|string;}
interface Operation {id:string;artifact_id:string;session_id:string;staging_version_id:string;candidate_canonical:string;candidate_sha256:string;received_at:Date|string;state:'queued'|'running'|'succeeded'|'failed';attempts:number;next_attempt_at:Date|string;updated_at:Date|string;lease_token:string|null;lease_expires_at:Date|string|null;error_code:string|null;}
interface Result {artifact_id:string;operation_id:string;object_key:string;object_version_id:string;staging_version_id:string;sha256:string;byte_size:number|string;content_type:string;accepted_at:Date|string;}
const iso=(v:Date|string)=>new Date(v).toISOString();
const identity=(a:SourceArtifactActor)=>a.kind==='partner'?{organizationId:a.partner.merchantId,environment:a.partner.environment,tenantId:a.partner.tenantId,userId:a.partner.actorUserId,binding:`${a.partner.principalId}:${a.partner.credentialId}:${a.partner.delegationGrantId??'direct'}`}:{...a.workspace,binding:a.workspace.membershipId};
function string(value:unknown,label:string,max=200):string {if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw new DomainError('INVALID_SOURCE_ARTIFACT',`${label} must contain 1 to ${max} printable characters`,400);if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bpp_org_(?:live|sandbox)_[A-Za-z0-9_-]{43}\b|https?:\/\/\S*[?&](?:X-Amz-Signature|token|api[_-]?key|sig|signature)=/i.test(value))throw new DomainError('ARTIFACT_SECRET_FIELD','Artifact metadata cannot contain credentials, private keys or signed access URLs',400);return value.trim();}
function version(value:string|null|undefined):string {if(!value||value==='null')throw new DomainError('EVIDENCE_VERSIONING_REQUIRED','Exact versioned staging and preserved storage is required for source artifacts',503);return value;}
export function parseSourceArtifact(input:unknown,partner=false) {
 const b=strictBody(input,['proofId','connectionId','sourceArtifactId','filename','contentType','byteSize','sha256','reportedAt','subjectId']);
 const proofId=string(b.proofId,'proofId'),connectionId=b.connectionId==null?null:string(b.connectionId,'connectionId');
 if(partner&&!connectionId)throw new DomainError('CONNECTION_REQUIRED','A service upload must identify its source connection',400);
 const contentType=string(b.contentType,'contentType',100).toLowerCase();validateAdmissionMetadata(contentType,b.byteSize as number);
 if(!Number.isSafeInteger(b.byteSize)||Number(b.byteSize)<1)throw new DomainError('INVALID_SOURCE_ARTIFACT','byteSize must be a positive whole number',400);
 const reportedAt=string(b.reportedAt,'reportedAt',64);
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(reportedAt)||!Number.isFinite(Date.parse(reportedAt))||new Date(`${reportedAt.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)!==reportedAt.slice(0,10))throw new DomainError('INVALID_SOURCE_ARTIFACT','reportedAt requires a valid ISO timestamp and UTC offset',400);
 const expectedSha256=b.sha256==null?null:string(b.sha256,'sha256',64).toLowerCase();if(expectedSha256&&!/^[a-f0-9]{64}$/.test(expectedSha256))throw new DomainError('INVALID_SOURCE_ARTIFACT','sha256 must contain 64 hexadecimal characters',400);
 return {proofId,connectionId,sourceArtifactId:b.sourceArtifactId==null?null:string(b.sourceArtifactId,'sourceArtifactId'),filename:string(b.filename,'filename'),contentType,byteSize:Number(b.byteSize),sha256:expectedSha256,reportedAt,subjectId:b.subjectId==null?proofId:string(b.subjectId,'subjectId')};
}
async function proofAccess(db:Database,clock:Clock,a:SourceArtifactActor,proofId:string,write:boolean,lock=false,admission=true) {
 const who=identity(a);
 if(a.kind==='human'&&a.workspace.partner)throw new DomainError('HUMAN_AUTHENTICATION_REQUIRED','A human attachment requires a current human session',403);
 if(a.kind==='partner')await authorizePartnerProof(db,clock,a.partner,proofId,write?'evidence:write':'exports:read');
 else await requireRecordAccess(db,a.workspace,proofId,write);
 if(lock){
  await db.query('INSERT INTO record_state(proof_id,organization_id,environment,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[proofId,who.organizationId,who.environment,clock.now().toISOString()]);
  await db.query('SELECT proof_id FROM record_state WHERE proof_id=$1 FOR UPDATE',[proofId]);
  if(a.kind==='partner')await authorizePartnerProof(db,clock,a.partner,proofId,write?'evidence:write':'exports:read');else await requireRecordAccess(db,a.workspace,proofId,write);
 }
 if(write&&admission)await assertHoldAdmissionOpen(db,proofId);
}
async function sourceAccess(db:Database,clock:Clock,a:SourceArtifactActor,proofId:string,connectionId:string|null,lock=false) {
 const who=identity(a);
 if(lock){await db.query('SELECT pg_advisory_xact_lock(1347438146,36)');const fence=(await db.query<{writes_enabled:boolean}>('SELECT writes_enabled FROM recovery_writer_fence WHERE singleton=1')).rows[0];if(!fence?.writes_enabled)throw new DomainError('RECOVERY_WRITERS_FENCED','Source preservation writes are paused for recovery',503);}
 if(connectionId&&lock)await db.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${who.organizationId}:${connectionId}`]);
 await proofAccess(db,clock,a,proofId,true,lock);
 if(!connectionId)return 0;
 const row=(await db.query<{paused:boolean|null;control_revision:number|string|null}>(`SELECT s.paused,s.control_revision FROM platform_integration_accounts a LEFT JOIN record_connection_state s ON s.connection_id=a.id
 WHERE a.id=$1 AND a.merchant_id=$2 AND a.environment=$3`,[connectionId,who.organizationId,who.environment])).rows[0];
 if(!row)throw new DomainError('CONNECTION_NOT_FOUND','Source connection not found',404);
 if(row.paused)throw new DomainError('CONNECTION_PAUSED','This source connection is paused',409);
 if(a.kind==='partner'&&!(await db.query('SELECT 1 FROM platform_external_bindings WHERE proof_id=$1 AND merchant_id=$2 AND environment=$3 AND integration_account_id=$4',[proofId,who.organizationId,who.environment,connectionId])).rows[0])throw new DomainError('SOURCE_PROOF_NOT_BOUND','The record is not bound to this source connection',409);
 return row.control_revision??0;
}
function bound(a:SourceArtifactActor,row:Artifact) {const w=identity(a);return w.organizationId===row.organization_id&&w.environment===row.environment&&a.kind===row.actor_kind&&(a.kind==='partner'?a.partner.principalId===row.principal_id&&a.partner.credentialId===row.credential_id&&a.partner.delegationGrantId===row.delegation_id:a.workspace.userId===row.actor_user_id&&a.workspace.membershipId===row.membership_id);}
async function currentArtifact(db:Database,clock:Clock,a:SourceArtifactActor,id:string,lock=false,controls=true) {
 const row=(await db.query<Artifact>('SELECT * FROM record_source_artifacts WHERE id=$1',[id])).rows[0];
 if(!row||!bound(a,row))throw new DomainError('UPLOAD_NOT_FOUND','Source upload not found',404);
 if(controls){const revision=await sourceAccess(db,clock,a,row.proof_id,row.connection_id,lock);if(String(revision)!==String(row.connection_revision))throw new DomainError('CONNECTION_CHANGED','Source connection settings changed. Preserve the original and begin a new source receipt after review.',409);}
 else await proofAccess(db,clock,a,row.proof_id,true,lock,false);
 if(sha256Hex(row.receipt_canonical)!==row.receipt_sha256)throw new DomainError('SOURCE_RECEIPT_INTEGRITY_FAILED','Source receipt integrity check failed',409);
 return row;
}
async function loadSession(db:Database,clock:Clock,a:SourceArtifactActor,id:string,lock=false,controls=true) {
 if(lock)await db.query('SELECT pg_advisory_xact_lock(1347438146,36)');
 const row=(await db.query<Session>(`SELECT * FROM record_source_upload_sessions WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
 if(!row)throw new DomainError('UPLOAD_NOT_FOUND','Source upload not found',404);
 const artifact=await currentArtifact(db,clock,a,row.artifact_id,lock,controls);return {session:row,artifact};
}
function assertOpen(session:Session,clock:Clock) {
 if(new Date(session.expires_at).getTime()<=clock.now().getTime())throw new DomainError('UPLOAD_EXPIRED','This upload reservation expired. Preserve the original and initialize a new source receipt.',409);
 if(['complete','expired','rejected'].includes(session.state))throw new DomainError('UPLOAD_CLOSED','This upload is closed',409);
 if(session.lease_token&&session.lease_expires_at&&new Date(session.lease_expires_at).getTime()>clock.now().getTime())throw new DomainError('UPLOAD_IN_PROGRESS','An upload request is already in progress',409);
}
async function change(db:Database,clock:Clock,row:Artifact,eventType:string,data:Record<string,unknown>,system=false) {
 const at=clock.now().toISOString();
 await db.query('UPDATE record_state SET revision=revision+1,updated_at=$2 WHERE proof_id=$1',[row.proof_id,at]);
 const auditId=await appendAudit(db,{proofId:row.proof_id,actorUserId:system?null:row.actor_user_id,eventType,eventData:{artifactId:row.id,sourceAssurance:row.actor_kind==='partner'?'organization_submitted':'human_uploaded_attachment',...data},at:clock.now()});
 await db.query('INSERT INTO proof_outbox(id,proof_id,audit_id,event_type,created_at) VALUES($1,$2,$3,$4,$5)',[`${auditId}:record.updated`,row.proof_id,auditId,'record.updated',at]);
}
async function checkpoint(db:Database,clock:Clock,row:Artifact,operationId:string,kind:'SOURCE_ARTIFACT_RESERVED'|'SOURCE_ARTIFACT_COMPLETION_REQUESTED'|'SOURCE_ARTIFACT_COMMITTED'|'SOURCE_ARTIFACT_FAILED',system=false) {
 await enqueueRecoveryEvent(db,clock,{operationId,kind,proofId:row.proof_id,actorUserId:system?null:row.actor_user_id,payload:await buildProofRecoverySnapshot(db,row.proof_id)});
}
function base(a:SourceArtifactActor) {const w=identity(a);return a.kind==='partner'?'/v1/partner':`/me/records`;}
function selectors(a:SourceArtifactActor) {const w=identity(a);return a.kind==='human'?`?organizationId=${encodeURIComponent(w.organizationId)}&environment=${w.environment}`:'';}
function sessionPath(a:SourceArtifactActor,id:string){return `${base(a)}/${a.kind==='partner'?'upload-sessions':'source-upload-sessions'}/${id}`;}
function operationView(a:SourceArtifactActor,o:Operation) {return {operationId:o.id,artifactId:o.artifact_id,state:o.state,receivedAt:iso(o.received_at),updatedAt:iso(o.updated_at),attempts:o.attempts,errorCode:o.error_code,nextAction:o.error_code?'Preserve the original; review source access and this receipt before starting a new upload.':null,links:{self:`${base(a)}/${a.kind==='partner'?'artifact-operations':'source-artifact-operations'}/${o.id}${selectors(a)}`}};}
export async function initializeSourceArtifact(db:Database,clock:Clock,a:SourceArtifactActor,input:unknown,key:unknown) {
 const parsed=parseSourceArtifact(input,a.kind==='partner'),who=identity(a);
 await sourceAccess(db,clock,a,parsed.proofId,parsed.connectionId);
 const result=await idempotent(db,clock,who.tenantId,`source-artifact-init:${who.environment}:${a.kind}:${who.binding}`,key,input,async tx=>{
  const connectionRevision=await sourceAccess(tx,clock,a,parsed.proofId,parsed.connectionId,true);
  if(parsed.subjectId!==parsed.proofId&&!(await tx.query('SELECT 1 FROM record_entities WHERE id=$1 AND proof_id=$2',[parsed.subjectId,parsed.proofId])).rows[0])throw new DomainError('SUBJECT_NOT_FOUND','Related subject not found in this record',404);
  await tx.query('SELECT pg_advisory_xact_lock(1347438151,hashtext($1))',[`${who.organizationId}:${who.environment}`]);
  const previous=parsed.sourceArtifactId?(await tx.query<Artifact>('SELECT * FROM record_source_artifacts WHERE organization_id=$1 AND environment=$2 AND connection_id IS NOT DISTINCT FROM $3 AND source_artifact_id=$4',[who.organizationId,who.environment,parsed.connectionId,parsed.sourceArtifactId])).rows[0]:null;
  if(previous)throw new DomainError('SOURCE_ARTIFACT_CONFLICT','This source artifact identity already has an immutable receipt. Resume its original session or use a new source identity for a new original.',409);
  const active=(await tx.query<{count:string}>(`SELECT COUNT(*) AS count FROM record_source_upload_sessions s JOIN record_source_artifacts a ON a.id=s.artifact_id WHERE a.organization_id=$1 AND a.environment=$2 AND a.actor_user_id=$3 AND COALESCE(a.principal_id,'')=$4 AND s.state IN ('open','receiving','received') AND s.expires_at>$5`,[who.organizationId,who.environment,who.userId,a.kind==='partner'?a.partner.principalId:'',clock.now().toISOString()])).rows[0];
  if(Number(active.count)>=SOURCE_ARTIFACT_LIMITS.activeUploads)throw new DomainError('UPLOAD_CONCURRENCY_LIMIT','Two source uploads are already active. Complete them before starting another.',429);
  const day=clock.now().toISOString().slice(0,10);
  await tx.query('INSERT INTO record_source_upload_budgets(organization_id,environment,reservation_day,reserved_bytes) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING',[who.organizationId,who.environment,day]);
  const budget=(await tx.query<{reserved_bytes:string}>('SELECT reserved_bytes FROM record_source_upload_budgets WHERE organization_id=$1 AND environment=$2 AND reservation_day=$3 FOR UPDATE',[who.organizationId,who.environment,day])).rows[0];
  if(Number(budget.reserved_bytes)+parsed.byteSize>SOURCE_ARTIFACT_LIMITS.dailyOrganizationBytes)throw new DomainError('UPLOAD_QUOTA_EXCEEDED','The organization daily source upload allowance is exhausted',429);
  await tx.query('UPDATE record_source_upload_budgets SET reserved_bytes=reserved_bytes+$4 WHERE organization_id=$1 AND environment=$2 AND reservation_day=$3',[who.organizationId,who.environment,day,parsed.byteSize]);
  const id=newId('source_artifact'),sessionId=newId('source_upload'),now=clock.now().toISOString(),receipt=canonicalize({schema:'packproof.source-artifact-receipt/v1',submittedMetadata:input,...parsed,sourceArtifactId:parsed.sourceArtifactId??id,actorKind:a.kind,receivedAt:now});
  await tx.query(`INSERT INTO record_source_artifacts(id,proof_id,organization_id,environment,connection_id,connection_revision,source_artifact_id,filename,content_type,declared_byte_size,expected_sha256,subject_id,reported_at,reported_at_original,received_at,actor_kind,actor_user_id,principal_id,credential_id,delegation_id,membership_id,actor_context,receipt_canonical,receipt_sha256)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24)`,[id,parsed.proofId,who.organizationId,who.environment,parsed.connectionId,connectionRevision,parsed.sourceArtifactId??id,parsed.filename,parsed.contentType,parsed.byteSize,parsed.sha256,parsed.subjectId,new Date(parsed.reportedAt).toISOString(),parsed.reportedAt,now,a.kind,who.userId,a.kind==='partner'?a.partner.principalId:null,a.kind==='partner'?a.partner.credentialId:null,a.kind==='partner'?a.partner.delegationGrantId:null,a.kind==='human'?a.workspace.membershipId:null,JSON.stringify(a),receipt,sha256Hex(receipt)]);
  await tx.query("INSERT INTO record_source_upload_sessions(id,artifact_id,state,staging_key,ingress_limit_bytes,expires_at,created_at,updated_at) VALUES($1,$2,'open',$3,$4,$5,$6,$6)",[sessionId,id,evidenceObjectKey(parsed.proofId,id),parsed.byteSize*2,new Date(clock.now().getTime()+SOURCE_ARTIFACT_LIMITS.reservationMs).toISOString(),now]);
  const row=(await tx.query<Artifact>('SELECT * FROM record_source_artifacts WHERE id=$1',[id])).rows[0];
  await change(tx,clock,row,'SOURCE_ARTIFACT_RESERVED',{});
  await checkpoint(tx,clock,row,`${id}:reserved`,'SOURCE_ARTIFACT_RESERVED');
  return {artifactId:id,sessionId};
 });
 await sourceAccess(db,clock,a,parsed.proofId,parsed.connectionId);
 return {...await readSourceUploadSession(db,clock,a,result.value.sessionId),replayed:result.replayed};
}
export async function readSourceUploadSession(db:Database,clock:Clock,a:SourceArtifactActor,id:string) {
 const {session:s,artifact:r}=await loadSession(db,clock,a,id,false,false),p=sessionPath(a,id),q=selectors(a);
 const parts=(await db.query<Part>('SELECT * FROM record_source_upload_parts WHERE session_id=$1 ORDER BY part_number',[id])).rows;
 const op=(await db.query<Operation>('SELECT * FROM record_source_artifact_operations WHERE session_id=$1',[id])).rows[0];
 const control=r.connection_id?(await db.query<{paused:boolean;control_revision:number|string}>('SELECT paused,control_revision FROM record_connection_state WHERE connection_id=$1',[r.connection_id])).rows[0]:null;
 const blockedReason=control?.paused?'CONNECTION_PAUSED':String(control?.control_revision??0)!==String(r.connection_revision)?'CONNECTION_CHANGED':null;
 await currentArtifact(db,clock,a,r.id,false,false);
 return {artifactId:r.id,sessionId:s.id,proofId:r.proof_id,connectionId:r.connection_id,sourceArtifactId:r.source_artifact_id,subjectId:r.subject_id,expectedSha256:r.expected_sha256,state:new Date(s.expires_at).getTime()<=clock.now().getTime()&&s.state!=='complete'?'expired':s.state,expiresAt:iso(s.expires_at),filename:r.filename,contentType:r.content_type,byteSize:Number(r.declared_byte_size),sourceAssurance:r.actor_kind==='partner'?'organization_submitted':'human_uploaded_attachment',reportedAt:iso(r.reported_at),receivedAt:iso(r.received_at),errorCode:s.error_code,resumable:!blockedReason&&!['complete','rejected','expired'].includes(s.state)&&new Date(s.expires_at).getTime()>clock.now().getTime(),blockedReason,partSize:SOURCE_ARTIFACT_LIMITS.partSize,receivedParts:parts.map(p=>({partNumber:p.part_number,byteSize:Number(p.byte_size),sha256:p.sha256})),upload:{method:'PUT',url:`${p}/bytes${q}`,headers:{'Content-Type':r.content_type}},partsUrl:`${p}/parts${q}`,assembleUrl:`${p}/parts/complete${q}`,completeUrl:`${p}/complete${q}`,operation:op?operationView(a,op):null};
}
function assertLease(s:Session,lease:string,clock:Clock) {if(s.lease_token!==lease||!s.lease_expires_at||new Date(s.lease_expires_at).getTime()<=clock.now().getTime()||s.state!=='receiving')throw new DomainError('UPLOAD_LEASE_LOST','The source upload lease expired or was reclaimed',409);}
async function ingressLease(db:Database,clock:Clock,a:SourceArtifactActor,id:string,byteSize:number,partNumber?:number,assembly=false) {
 return db.transaction(async tx=>{
  const {session:s,artifact:r}=await loadSession(tx,clock,a,id,true);assertOpen(s,clock);
  const size=Number(r.declared_byte_size),count=Math.ceil(size/SOURCE_ARTIFACT_LIMITS.partSize);
  if(s.state==='received')throw new DomainError('UPLOAD_ALREADY_RECEIVED','The original has already been received; complete the session',409);
  if(partNumber!==undefined&&(!Number.isSafeInteger(partNumber)||partNumber<1||partNumber>count))throw new DomainError('INVALID_UPLOAD_PART','Part number is outside this reservation',400);
  const expected=partNumber===undefined?size:Math.min(SOURCE_ARTIFACT_LIMITS.partSize,size-(partNumber-1)*SOURCE_ARTIFACT_LIMITS.partSize);
  if(byteSize!==expected)throw new DomainError('UPLOAD_SIZE_MISMATCH','Upload bytes must match the reserved whole file or exact part length',413);
  if(!assembly&&Number(s.ingress_bytes)+byteSize>Number(s.ingress_limit_bytes))throw new DomainError('UPLOAD_INGRESS_LIMIT','This reservation reached its bounded retry allowance. Preserve the original.',429);
  const lease=newId('source_ingress');
  await tx.query("UPDATE record_source_upload_sessions SET state='receiving',ingress_bytes=ingress_bytes+$2,lease_token=$3,lease_expires_at=$4,updated_at=$5 WHERE id=$1",[id,assembly?0:byteSize,lease,new Date(clock.now().getTime()+SOURCE_ARTIFACT_LIMITS.ingressLifetimeMs).toISOString(),clock.now().toISOString()]);
  return {session:s,artifact:r,lease,key:partNumber===undefined?s.staging_key:`${s.staging_key}.parts/${partNumber}-${lease}`,partNumber};
 });
}
async function releaseIngress(db:Database,clock:Clock,id:string,lease:string) {await db.query("UPDATE record_source_upload_sessions SET state='open',lease_token=NULL,lease_expires_at=NULL,updated_at=$3 WHERE id=$1 AND lease_token=$2 AND state='receiving'",[id,lease,clock.now().toISOString()]);}
async function receive(db:Database,clock:Clock,store:ObjectStore,a:SourceArtifactActor,id:string,source:AsyncIterable<Uint8Array>,byteSize:number,partNumber?:number,assembly=false) {
 if(!store.putStream||!store.getStream)throw new DomainError('UPLOAD_STREAM_UNAVAILABLE','Versioned streaming storage is required',503);
 const claim=await ingressLease(db,clock,a,id,byteSize,partNumber,assembly),hash=createHash('sha256');let received=0;
 const started=Date.now();let checked=0;
 async function* checkedSource() {for await(const chunk of source){const bytes=Buffer.from(chunk);received+=bytes.length;if(received>byteSize||Date.now()-started>SOURCE_ARTIFACT_LIMITS.ingressLifetimeMs)throw new DomainError('UPLOAD_SIZE_MISMATCH','Upload exceeded its reserved length or time',413);if(received-checked>=1024*1024||checked===0){await currentArtifact(db,clock,a,claim.artifact.id);checked=received;}hash.update(bytes);yield bytes;}if(received!==byteSize)throw new DomainError('UPLOAD_SIZE_MISMATCH','Upload ended before its reserved length',422);}
 try {
  const saved=await store.putStream(claim.key,partNumber===undefined?verifyMediaSignature(checkedSource(),claim.artifact.content_type):checkedSource(),claim.artifact.content_type,byteSize),savedVersion=version(saved.versionId),digest=hash.digest('hex');
  await db.transaction(async tx=>{
   const {session:s,artifact:r}=await loadSession(tx,clock,a,id,true);assertLease(s,claim.lease,clock);
   if(new Date(s.expires_at).getTime()<=clock.now().getTime())throw new DomainError('UPLOAD_EXPIRED','Upload reservation expired',409);
   if(partNumber!==undefined){
    const previous=(await tx.query<Part>('SELECT * FROM record_source_upload_parts WHERE session_id=$1 AND part_number=$2',[id,partNumber])).rows[0];
    if(previous&&(previous.sha256!==digest||Number(previous.byte_size)!==byteSize))throw new DomainError('UPLOAD_PART_CONFLICT','This part already contains different original bytes',409);
    if(!previous)await tx.query('INSERT INTO record_source_upload_parts(session_id,part_number,object_key,object_version_id,sha256,byte_size,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,partNumber,claim.key,savedVersion,digest,byteSize,clock.now().toISOString()]);
    await tx.query("UPDATE record_source_upload_sessions SET state='open',lease_token=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1",[id,clock.now().toISOString()]);
    if(!previous){await change(tx,clock,r,'SOURCE_ARTIFACT_PART_RECEIVED',{partNumber,sha256:digest,byteSize});await checkpoint(tx,clock,r,`${id}:part:${partNumber}`,'SOURCE_ARTIFACT_RESERVED');}
   }else {
    if(r.expected_sha256&&r.expected_sha256!==digest)throw new DomainError('EVIDENCE_HASH_MISMATCH','Original bytes do not match the supplied full-file SHA-256',422);
    await tx.query("UPDATE record_source_upload_sessions SET state='received',staging_version_id=$2,received_byte_size=$3,received_sha256=$4,lease_token=NULL,lease_expires_at=NULL,updated_at=$5 WHERE id=$1",[id,savedVersion,byteSize,digest,clock.now().toISOString()]);
    await change(tx,clock,r,'SOURCE_ARTIFACT_UPLOAD_RECEIVED',{sha256:digest,byteSize});await checkpoint(tx,clock,r,`${id}:received`,'SOURCE_ARTIFACT_RESERVED');
   }
   assertLease({...s,state:'receiving'},claim.lease,clock);
  });
  return {sessionId:id,artifactId:claim.artifact.id,state:partNumber===undefined?'received':'open',...(partNumber===undefined?{byteSize,sha256:digest}:{partNumber,byteSize,sha256:digest})};
 }catch(error){await releaseIngress(db,clock,id,claim.lease);throw error;}
}
export async function receiveSourceArtifactBytes(db:Database,clock:Clock,store:ObjectStore,a:SourceArtifactActor,id:string,source:AsyncIterable<Uint8Array>,byteSize:number,partNumber?:number) {return receive(db,clock,store,a,id,source,byteSize,partNumber);}
export async function assembleSourceArtifactParts(db:Database,clock:Clock,store:ObjectStore,a:SourceArtifactActor,id:string) {
 const {session:s,artifact:r}=await loadSession(db,clock,a,id);
 if(s.state==='received')return readSourceUploadSession(db,clock,a,id);
 const parts=(await db.query<Part>('SELECT * FROM record_source_upload_parts WHERE session_id=$1 ORDER BY part_number',[id])).rows,size=Number(r.declared_byte_size);
 if(parts.length!==Math.ceil(size/SOURCE_ARTIFACT_LIMITS.partSize)||parts.some((p,i)=>p.part_number!==i+1))throw new DomainError('UPLOAD_PARTS_MISSING','Upload every reserved part before assembly',409);
 async function* original(){for(const part of parts){if(!store.getStream)throw new DomainError('UPLOAD_STREAM_UNAVAILABLE','Versioned streaming storage is required',503);const object=await store.getStream(part.object_key,{versionId:part.object_version_id});if(!object||object.versionId!==part.object_version_id||object.byteSize!==Number(part.byte_size))throw new DomainError('UPLOAD_PART_INTEGRITY_FAILED','An exact original upload part is unavailable',409);const hash=createHash('sha256');let count=0;try{for await(const chunk of object.body){const b=Buffer.from(chunk);count+=b.length;hash.update(b);yield b;}if(count!==Number(part.byte_size)||hash.digest('hex')!==part.sha256)throw new DomainError('UPLOAD_PART_INTEGRITY_FAILED','Original upload part digest mismatch',409);}finally{object.body.destroy();}}}
 await receive(db,clock,store,a,id,original(),size,undefined,true);return readSourceUploadSession(db,clock,a,id);
}
export async function completeSourceArtifact(db:Database,clock:Clock,a:SourceArtifactActor,id:string) {
 return db.transaction(async tx=>{
  const {session:s,artifact:r}=await loadSession(tx,clock,a,id,true);
  const existing=(await tx.query<Operation>('SELECT * FROM record_source_artifact_operations WHERE session_id=$1',[id])).rows[0];if(existing)return operationView(a,existing);
  assertOpen(s,clock);if(s.state!=='received'||Number(s.received_byte_size)!==Number(r.declared_byte_size)||!s.received_sha256||!/^[a-f0-9]{64}$/.test(s.received_sha256))throw new DomainError('UPLOAD_NOT_RECEIVED','Finish uploading the exact original before completing',409);
  const stagingVersion=version(s.staging_version_id),operationId=newId('source_completion'),now=clock.now().toISOString(),candidate=canonicalize({schema:'packproof.source-artifact-completion/v1',artifactId:r.id,receiptSha256:r.receipt_sha256,stagingKey:s.staging_key,stagingVersionId:stagingVersion,sha256:s.received_sha256,byteSize:Number(s.received_byte_size),contentType:r.content_type,expectedSha256:r.expected_sha256});
  await tx.query("INSERT INTO record_source_artifact_operations(id,artifact_id,session_id,staging_version_id,candidate_canonical,candidate_sha256,received_at,state,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$7,$7)",[operationId,r.id,id,stagingVersion,candidate,sha256Hex(candidate),now]);
  await tx.query("UPDATE record_source_upload_sessions SET state='complete',updated_at=$2 WHERE id=$1",[id,now]);
  await change(tx,clock,r,'SOURCE_ARTIFACT_COMPLETION_REQUESTED',{operationId});
  await checkpoint(tx,clock,r,operationId,'SOURCE_ARTIFACT_COMPLETION_REQUESTED');
  return operationView(a,(await tx.query<Operation>('SELECT * FROM record_source_artifact_operations WHERE id=$1',[operationId])).rows[0]);
 });
}
export async function readSourceArtifactOperation(db:Database,clock:Clock,a:SourceArtifactActor,id:string) {
 const op=(await db.query<Operation>('SELECT * FROM record_source_artifact_operations WHERE id=$1',[id])).rows[0];if(!op)throw new DomainError('OPERATION_NOT_FOUND','Source artifact operation not found',404);
 const r=await currentArtifact(db,clock,a,op.artifact_id,false,false),result=(await db.query<Result>('SELECT * FROM record_source_artifact_results WHERE operation_id=$1',[id])).rows[0];
 await currentArtifact(db,clock,a,op.artifact_id,false,false);
 return {...operationView(a,op),proofId:r.proof_id,sourceAssurance:r.actor_kind==='partner'?'organization_submitted':'human_uploaded_attachment',result:result?{artifactId:r.id,sha256:result.sha256,byteSize:Number(result.byte_size),contentType:result.content_type,acceptedAt:iso(result.accepted_at)}:null};
}
function operationLease(row:Operation|undefined,lease:string,clock:Clock) {if(!row||row.state!=='running'||row.lease_token!==lease||!row.lease_expires_at||new Date(row.lease_expires_at).getTime()<=clock.now().getTime())throw new DomainError('ARTIFACT_LEASE_LOST','The source artifact worker lease expired or was reclaimed',409);}
async function terminalFailure(db:Database,clock:Clock,job:Operation,code:string){
 const row=(await db.query<Artifact>('SELECT * FROM record_source_artifacts WHERE id=$1',[job.artifact_id])).rows[0];
 await db.query('SELECT proof_id FROM record_state WHERE proof_id=$1 FOR UPDATE',[row.proof_id]);
 await db.query("UPDATE record_source_artifact_operations SET state='failed',error_code=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=$3 WHERE id=$1",[job.id,code,clock.now().toISOString()]);
 await change(db,clock,row,'SOURCE_ARTIFACT_PROCESSING_FAILED',{operationId:job.id,errorCode:code},true);
 await checkpoint(db,clock,row,`${job.id}:failed`,'SOURCE_ARTIFACT_FAILED',true);
}
export async function processSourceArtifactCompletions(db:Database,clock:Clock,store:ObjectStore,limit=2) {
 let processed=0;
 for(let i=0;i<Math.max(1,Math.min(10,limit));i++){
  const lease=newId('artifact_lease'),now=clock.now();
  const job=await db.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(1347438146,36)');if(!(await tx.query<{writes_enabled:boolean}>('SELECT writes_enabled FROM recovery_writer_fence WHERE singleton=1')).rows[0]?.writes_enabled)return null;const row=(await tx.query<Operation>("SELECT * FROM record_source_artifact_operations WHERE (state='queued' AND next_attempt_at<=$1) OR (state='running' AND lease_expires_at<=$1) ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",[now.toISOString()])).rows[0];if(!row)return null;if(row.attempts>=5){await terminalFailure(tx,clock,row,'ARTIFACT_RETRY_EXHAUSTED');return {exhausted:true} as const;}await tx.query("UPDATE record_source_artifact_operations SET state='running',attempts=attempts+1,lease_token=$2,lease_expires_at=$3,updated_at=$4 WHERE id=$1",[row.id,lease,new Date(now.getTime()+SOURCE_ARTIFACT_LIMITS.leaseMs).toISOString(),now.toISOString()]);return row;});
  if(!job)break;
  if('exhausted'in job)continue;
  const raw=(await db.query<Artifact>('SELECT * FROM record_source_artifacts WHERE id=$1',[job.artifact_id])).rows[0];
  try{
   const a=raw.actor_context;
   await db.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(1347438146,36)');operationLease((await tx.query<Operation>('SELECT * FROM record_source_artifact_operations WHERE id=$1 FOR UPDATE',[job.id])).rows[0],lease,clock);await currentArtifact(tx,clock,a,job.artifact_id,true);});
   if(sha256Hex(job.candidate_canonical)!==job.candidate_sha256)throw new DomainError('SOURCE_CANDIDATE_INTEGRITY_FAILED','Accepted completion candidate digest mismatch',409);
   const candidate=JSON.parse(job.candidate_canonical) as {artifactId:string;receiptSha256:string;stagingKey:string;stagingVersionId:string;sha256:string;byteSize:number;contentType:string;expectedSha256:string|null};
   const session=(await db.query<Session>('SELECT * FROM record_source_upload_sessions WHERE id=$1',[job.session_id])).rows[0];
   if(!session||session.artifact_id!==raw.id||session.staging_version_id!==job.staging_version_id||session.received_sha256!==candidate.sha256||Number(session.received_byte_size)!==candidate.byteSize||candidate.artifactId!==raw.id||candidate.receiptSha256!==raw.receipt_sha256||candidate.stagingKey!==evidenceObjectKey(raw.proof_id,raw.id)||candidate.stagingVersionId!==job.staging_version_id||!/^[a-f0-9]{64}$/.test(candidate.sha256)||candidate.byteSize!==Number(raw.declared_byte_size)||candidate.contentType!==raw.content_type||candidate.expectedSha256!==raw.expected_sha256)throw new DomainError('SOURCE_CANDIDATE_INTEGRITY_FAILED','Accepted candidate does not match its source receipt',409);
   const preserved=await store.commitUpload(candidate.stagingKey,{expectedVersionId:job.staging_version_id,sha256:candidate.sha256,byteSize:candidate.byteSize,contentType:candidate.contentType,maxBytes:SOURCE_ARTIFACT_LIMITS.maximumBytes});
   if(!preserved)throw new DomainError('SOURCE_ORIGINAL_UNAVAILABLE','The accepted exact original is unavailable; preserve the source file and review storage recovery',503);
   if(preserved.stagingVersionId!==job.staging_version_id||preserved.sha256!==candidate.sha256||preserved.byteSize!==candidate.byteSize||preserved.contentType!==candidate.contentType||preserved.key!==committedEvidenceObjectKey(candidate.stagingKey,preserved.sha256)||raw.expected_sha256&&preserved.sha256!==raw.expected_sha256)throw new DomainError('SOURCE_ORIGINAL_INTEGRITY_FAILED','Preserved original does not match the accepted candidate',409);
   const preservedVersion=version(preserved.versionId);
   await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(1347438146,36)');
    const locked=(await tx.query<Operation>('SELECT * FROM record_source_artifact_operations WHERE id=$1 FOR UPDATE',[job.id])).rows[0];operationLease(locked,lease,clock);
    const r=await currentArtifact(tx,clock,a,job.artifact_id,true),at=clock.now().toISOString();
    await tx.query('INSERT INTO record_source_artifact_results(artifact_id,operation_id,object_key,object_version_id,staging_version_id,sha256,byte_size,content_type,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[r.id,job.id,preserved.key,preservedVersion,job.staging_version_id,preserved.sha256,preserved.byteSize,preserved.contentType,at]);
    await tx.query("UPDATE record_source_artifact_operations SET state='succeeded',error_code=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1",[job.id,at]);
    await change(tx,clock,r,'SOURCE_ARTIFACT_COMMITTED',{operationId:job.id,sha256:preserved.sha256,byteSize:preserved.byteSize});
    await checkpoint(tx,clock,r,`${job.id}:committed`,'SOURCE_ARTIFACT_COMMITTED');
    operationLease(locked,lease,clock);
   });processed++;
  }catch(error){
   if(error instanceof DomainError&&error.code==='ARTIFACT_LEASE_LOST')continue;
   await db.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(1347438146,36)');if(!(await tx.query<{writes_enabled:boolean}>('SELECT writes_enabled FROM recovery_writer_fence WHERE singleton=1')).rows[0]?.writes_enabled)return;const current=(await tx.query<Operation>('SELECT * FROM record_source_artifact_operations WHERE id=$1 FOR UPDATE',[job.id])).rows[0];try{operationLease(current,lease,clock);}catch{return;}
    const retry=(!(error instanceof DomainError)||error.httpStatus>=500)&&current.attempts<5,at=clock.now().toISOString();
    if(retry)await tx.query("UPDATE record_source_artifact_operations SET state='queued',error_code=$2,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=$3,updated_at=$4 WHERE id=$1",[job.id,error instanceof DomainError?error.code:'SOURCE_STORAGE_UNAVAILABLE',new Date(clock.now().getTime()+Math.min(3600000,30000*2**current.attempts)).toISOString(),at]);
    else {await terminalFailure(tx,clock,current,error instanceof DomainError?error.code:'SOURCE_STORAGE_UNAVAILABLE');operationLease(current,lease,clock);}
   });
  }
 }
 return {processed};
}
function artifactCursorKey(){const key=Buffer.from(process.env.PACKPROOF_EVENT_CURSOR_KEY??'','base64');if(key.length!==32)throw new DomainError('RECORD_CURSOR_UNAVAILABLE','Source artifact pagination is waiting for cursor configuration',503);return key;}
function encodeArtifactCursor(scope:string,row:{received_at:Date|string;id:string},clock:Clock){const body=Buffer.from(JSON.stringify({v:1,scope,receivedAt:iso(row.received_at),id:row.id,expires:clock.now().getTime()+3600000})).toString('base64url');return `${body}.${createHmac('sha256',artifactCursorKey()).update(body).digest('base64url')}`;}
function decodeArtifactCursor(value:unknown,scope:string,clock:Clock):{receivedAt:string;id:string}|null{
 if(value==null)return null;
 try{if(typeof value!=='string'||value.length>2000)throw 0;const [body,signature,extra]=value.split('.'),actual=Buffer.from(signature??'','base64url'),expected=createHmac('sha256',artifactCursorKey()).update(body).digest();if(extra||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw 0;const p=JSON.parse(Buffer.from(body,'base64url').toString());if(p.v!==1||p.scope!==scope||typeof p.id!=='string'||!Number.isFinite(Date.parse(p.receivedAt))||!Number.isSafeInteger(p.expires))throw 0;if(p.expires<=clock.now().getTime())throw new DomainError('RECORD_CURSOR_EXPIRED','Refresh source artifacts to start a new page',410);return p;}catch(error){if(error instanceof DomainError)throw error;throw new DomainError('INVALID_CURSOR','Use the cursor from this record and current actor',400);}
}
export async function listSourceArtifacts(db:Database,clock:Clock,a:SourceArtifactActor,proofId:string,input:Record<string,unknown>={}) {
 await proofAccess(db,clock,a,proofId,false);
 const limit=input.limit==null?100:Number(input.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('INVALID_LIMIT','limit must be from 1 to 100',400);
 const who=identity(a),scope=sha256Hex(canonicalize({resource:'source_artifacts',proofId,organizationId:who.organizationId,environment:who.environment,actorKind:a.kind,binding:who.binding,limit})),cursor=decodeArtifactCursor(input.cursor,scope,clock);
 const rows=(await db.query<any>(`SELECT a.id,a.filename,a.content_type,a.declared_byte_size,a.subject_id,a.reported_at,a.received_at,a.actor_kind,a.connection_id,a.source_artifact_id,
 r.sha256,r.byte_size,r.accepted_at,s.state AS upload_state,o.state AS operation_state,o.error_code,(SELECT COUNT(*) FROM record_source_artifacts WHERE proof_id=$1) AS total
 FROM record_source_artifacts a JOIN record_source_upload_sessions s ON s.artifact_id=a.id LEFT JOIN record_source_artifact_operations o ON o.artifact_id=a.id LEFT JOIN record_source_artifact_results r ON r.artifact_id=a.id WHERE a.proof_id=$1 AND ($2::timestamptz IS NULL OR (a.received_at,a.id)<($2::timestamptz,$3::text)) ORDER BY a.received_at DESC,a.id DESC LIMIT $4`,[proofId,cursor?.receivedAt??null,cursor?.id??null,limit+1])).rows;
 await proofAccess(db,clock,a,proofId,false);
 const total=rows[0]?.total??(await db.query<{total:string}>('SELECT COUNT(*) AS total FROM record_source_artifacts WHERE proof_id=$1',[proofId])).rows[0].total;
 const page=rows.slice(0,limit),hasMore=rows.length>limit,last=page.at(-1);
 return {artifacts:page.map(r=>({artifactId:r.id,proofId,filename:r.filename,contentType:r.content_type,subjectId:r.subject_id,connectionId:r.connection_id,sourceArtifactId:r.source_artifact_id,sourceAssurance:r.actor_kind==='partner'?'organization_submitted':'human_uploaded_attachment',state:r.sha256?'available':r.operation_state??r.upload_state,byteSize:Number(r.byte_size??r.declared_byte_size),sha256:r.sha256??null,reportedAt:iso(r.reported_at),receivedAt:iso(r.received_at),acceptedAt:r.accepted_at?iso(r.accepted_at):null,errorCode:r.error_code??null,downloadAvailable:!!r.sha256,derivation:null})),total:Number(total),hasMore,limit,nextCursor:hasMore&&last?encodeArtifactCursor(scope,last,clock):null};
}
export async function readSourceArtifactStream(db:Database,clock:Clock,store:ObjectStore,a:SourceArtifactActor,id:string,range?:string,proofId?:string) {
 const who=identity(a),row=(await db.query<Artifact&Result>(`SELECT a.*,r.object_key,r.object_version_id,r.sha256,r.byte_size,r.accepted_at FROM record_source_artifacts a JOIN record_source_artifact_results r ON r.artifact_id=a.id WHERE a.id=$1 AND a.organization_id=$2 AND a.environment=$3`,[id,who.organizationId,who.environment])).rows[0];
 if(!row||proofId&&row.proof_id!==proofId)throw new DomainError('EVIDENCE_NOT_FOUND','Preserved source artifact not found',404);
 const authorize=()=>proofAccess(db,clock,a,row.proof_id,false);
 await authorize();const media=await streamPreservedObject(store,{id:row.id,object_key:row.object_key,object_version_id:row.object_version_id,sha256:row.sha256,byte_size:row.byte_size,content_type:row.content_type},range);
 try{await authorize();await auditOrganization(db,clock,a.kind==='partner'?{actor:a.partner,requestId:newId('req'),operation:'SOURCE_ORIGINAL_DOWNLOAD_REQUESTED',resourceId:row.id}:{userId:who.userId,merchantId:who.organizationId,requestId:newId('req'),operation:'SOURCE_ORIGINAL_DOWNLOAD_REQUESTED',resourceId:row.id});}catch(error){media.body?.destroy();throw error;}
 return {...media,proofId:row.proof_id,body:media.body?guardAuthorizedStream(media.body,authorize):null};
}

export async function readPartnerArtifactOrEvidenceStream(db:Database,clock:Clock,store:ObjectStore,a:PartnerActor,id:string,range?:string) {
 await reauthorizePartner(db,clock,a,'exports:read');
 const target=(await db.query<{proof_id:string;kind:string}>(`SELECT e.proof_id,'capture' AS kind FROM evidence e JOIN platform_proof_ownership o ON o.proof_id=e.proof_id WHERE e.id=$1 AND o.merchant_id=$2 AND o.environment=$3
 UNION ALL SELECT a.proof_id,'source' AS kind FROM record_source_artifacts a WHERE a.id=$1 AND a.organization_id=$2 AND a.environment=$3`,[id,a.merchantId,a.environment])).rows[0];
 if(!target)throw new DomainError('EVIDENCE_NOT_FOUND','Preserved evidence not found',404);
 await authorizePartnerProof(db,clock,a,target.proof_id,'exports:read');
 if(target.kind==='source')return readSourceArtifactStream(db,clock,store,{kind:'partner',partner:a},id,range);
 const media=await readCommittedEvidenceStream(withPartnerReadGrant(db,clock,a,target.proof_id,'exports:read'),store,a.actorUserId,target.proof_id,id,range);
 try{await authorizePartnerProof(db,clock,a,target.proof_id,'exports:read');await auditOrganization(db,clock,{actor:a,requestId:newId('req'),operation:'RECORD_ORIGINAL_DOWNLOAD_REQUESTED',resourceId:id});}catch(error){media.body?.destroy();throw error;}
 return {...media,proofId:target.proof_id,body:media.body?guardAuthorizedStream(media.body,()=>authorizePartnerProof(db,clock,a,target.proof_id,'exports:read').then(()=>undefined)):null};
}

/** Restore qualification verifies exact original references, never latest keys. */
export async function verifyRestoredSourceArtifacts(store:ObjectStore,tables:Record<string,unknown[]>):Promise<void> {
 const artifacts=tables.record_source_artifacts as Artifact[]|undefined,results=tables.record_source_artifact_results as Result[]|undefined;
 const sessions=tables.record_source_upload_sessions as Session[]|undefined,parts=tables.record_source_upload_parts as Part[]|undefined,operations=tables.record_source_artifact_operations as Operation[]|undefined;
 const invalid=(message:string):never=>{throw new DomainError('RECOVERY_SOURCE_ARTIFACT_INVALID',message,409);};
 for(const r of artifacts??[]){
  if(sha256Hex(r.receipt_canonical)!==r.receipt_sha256)throw new DomainError('RECOVERY_SOURCE_RECEIPT_INVALID','Recovered source receipt digest mismatch',409);
  const receipt=JSON.parse(r.receipt_canonical);
  if(receipt.schema!=='packproof.source-artifact-receipt/v1'||receipt.proofId!==r.proof_id||receipt.connectionId!==r.connection_id||receipt.sourceArtifactId!==r.source_artifact_id||receipt.filename!==r.filename||receipt.contentType!==r.content_type||receipt.byteSize!==Number(r.declared_byte_size)||receipt.sha256!==r.expected_sha256||receipt.subjectId!==r.subject_id||receipt.reportedAt!==r.reported_at_original||new Date(receipt.reportedAt).toISOString()!==iso(r.reported_at)||receipt.actorKind!==r.actor_kind||receipt.receivedAt!==iso(r.received_at)||!bound(r.actor_context,r))invalid('Recovered source receipt fields or actor binding mismatch');
 }
 for(const s of sessions??[]){
  const a=artifacts?.find(a=>a.id===s.artifact_id);if(!a||s.staging_key!==evidenceObjectKey(a.proof_id,a.id)||Number(s.ingress_limit_bytes)!==Number(a.declared_byte_size)*2||Number(s.ingress_bytes)<0||Number(s.ingress_bytes)>Number(s.ingress_limit_bytes))invalid('Recovered source reservation mismatch');
  if(s.staging_version_id&&!results?.some(r=>r.artifact_id===s.artifact_id)){
   const found=await store.digest(s.staging_key,{versionId:version(s.staging_version_id)});
   if(!found||found.versionId!==s.staging_version_id||found.sha256!==s.received_sha256||found.byteSize!==Number(a!.declared_byte_size)||found.contentType!==a!.content_type||Number(s.received_byte_size)!==Number(a!.declared_byte_size)||a!.expected_sha256&&found.sha256!==a!.expected_sha256)invalid('Recovered pending exact original failed verification');
  }
 }
 for(const p of parts??[]){
  const s=sessions?.find(s=>s.id===p.session_id),a=artifacts?.find(a=>a.id===s?.artifact_id);if(!s||!a||!Number.isInteger(p.part_number)||p.part_number<1||!p.object_key.startsWith(`${s.staging_key}.parts/${p.part_number}-`))invalid('Recovered source part attribution mismatch');
  const expected=Math.min(SOURCE_ARTIFACT_LIMITS.partSize,Number(a!.declared_byte_size)-(p.part_number-1)*SOURCE_ARTIFACT_LIMITS.partSize);if(expected<1||Number(p.byte_size)!==expected)invalid('Recovered source part length mismatch');
  // Once accepted, immutable committed originals are authoritative; their
  // expired staging parts need not remain retained forever.
  if(!results?.some(r=>r.artifact_id===a!.id)){const found=await store.digest(p.object_key,{versionId:version(p.object_version_id)});if(!found||found.versionId!==p.object_version_id||found.sha256!==p.sha256||found.byteSize!==Number(p.byte_size)||found.contentType!==a!.content_type)invalid('Recovered exact source upload part failed verification');}
 }
 for(const op of operations??[]){const a=artifacts?.find(a=>a.id===op.artifact_id),s=sessions?.find(s=>s.id===op.session_id),candidate=JSON.parse(op.candidate_canonical);if(!a||!s||s.artifact_id!==a.id||sha256Hex(op.candidate_canonical)!==op.candidate_sha256||candidate.schema!=='packproof.source-artifact-completion/v1'||candidate.artifactId!==a.id||candidate.receiptSha256!==a.receipt_sha256||candidate.stagingKey!==s.staging_key||candidate.stagingVersionId!==op.staging_version_id||s.staging_version_id!==op.staging_version_id||candidate.sha256!==s.received_sha256||!/^[a-f0-9]{64}$/.test(candidate.sha256)||candidate.byteSize!==Number(a.declared_byte_size)||candidate.contentType!==a.content_type||candidate.expectedSha256!==a.expected_sha256)invalid('Recovered completion candidate mismatch');}
 for(const r of results??[]){const a=artifacts?.find(a=>a.id===r.artifact_id),op=operations?.find(op=>op.id===r.operation_id);if(!a||r.content_type!==a.content_type||Number(r.byte_size)!==Number(a.declared_byte_size)||r.object_key!==committedEvidenceObjectKey(evidenceObjectKey(a.proof_id,a.id),r.sha256)||a.expected_sha256&&r.sha256!==a.expected_sha256||(operations!==undefined&&(!op||op.artifact_id!==r.artifact_id||op.staging_version_id!==r.staging_version_id||JSON.parse(op.candidate_canonical).sha256!==r.sha256)))invalid('Recovered source artifact attribution mismatch');const found=await store.digest(r.object_key,{versionId:version(r.object_version_id)});if(!found||found.versionId!==r.object_version_id||found.sha256!==r.sha256||found.byteSize!==Number(r.byte_size)||found.contentType!==r.content_type)invalid('Recovered exact source original failed verification');}
}
