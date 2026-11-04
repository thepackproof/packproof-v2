import { randomUUID } from 'node:crypto';
import { base64url, flattenedVerify, importSPKI } from 'jose';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { appendAudit } from '../domain/audit.js';
import { buildProofRecoverySnapshot, enqueueRecoveryEvent, getRecoveryStatus, verifyRecoveryEnvelope, type PreservationReceipt } from '../domain/recovery-journal.js';
import { requireHumanActor } from '../platform/organization-access.js';
import {authorizePartnerProof} from '../platform/organizations.js';
import { jcsBytes, sha256, type EnvelopeJws } from '../integrity/envelope-profile.js';
import { validateEnvelopeReceipt, type ProtectedReceipt } from '../integrity/envelope-jobs.js';
import { requireRecordAccess, type RecordWorkspace } from './access.js';
import { expectedRevision, ensureRecordState } from './service.js';
import { OPERATIONAL_EVALUATION_PROFILE, OPERATIONAL_MANIFEST_PROFILE, OPERATIONAL_SNAPSHOT_TYPE, OPERATIONAL_MAX_METADATA, SNAPSHOT_SECTION_FIELDS, evaluateSnapshotRequirements, operationalEnvelope, snapshotCheck, snapshotExact, snapshotId, validateOperationalEnvelope, validateOperationalManifest, type OperationalManifest, type OperationalArtifact, type SnapshotRow } from './operational-snapshot-profile.js';
import type { OperationalSnapshotRuntime } from './operational-snapshot-runtime.js';
import { streamZip, type ZipStreamEntry } from '../export/zip-stream.js';

export interface OperationalSnapshotCandidate {
  profile:'packproof.operational-snapshot-job.v1';manifest:OperationalManifest;coreCanonicalJson:string;priorManifestCanonicalJson:string|null;
  issuer:string;keyId:string;artifactBucket:string;retainUntil:string;writerGeneration:string;
}
export interface OperationalSnapshotBundle {
  profile:'packproof.operational-snapshot-result.v1';snapshotId:string;requestSha256:string;
  jws:EnvelopeJws;manifestReceipt:ProtectedReceipt;coreReceipt:ProtectedReceipt;priorReceipt:ProtectedReceipt|null;
  artifactReceipts:ProtectedReceipt[];sourceReceipt:PreservationReceipt;
}
export interface CandidateRow {snapshot_id:string;proof_id:string;organization_id:string;environment:string;revision:number;actor_user_id:string;membership_id:string;location_id:string|null;manifest_json:string;manifest_sha256:string;request_json:string;request_sha256:string;idempotency_key_hash:string;input_sha256:string;created_at:string|Date;attempts?:number;}
export const operationalSnapshotRequestOperation=(id:string)=>`operational-snapshot-request:${id}`;
export const operationalSnapshotResultOperation=(id:string)=>`operational-snapshot-signed:${id}`;
export const operationalSnapshotResultKey=(id:string)=>`integrity/v1/envelopes/${sha256(`operational-snapshot:${id}`)}.json`;
const manifestKey=(digest:string)=>`integrity/v1/manifests/${digest}.json`;
const same=(a:unknown,b:unknown)=>jcsBytes(a).equals(jcsBytes(b));
const iso=(v:unknown)=>v===null?null:new Date(v as string|Date).toISOString();
const normalized=(v:unknown)=>JSON.parse(JSON.stringify(v));
async function consistentCommand<T>(db:Database,fn:(tx:Database)=>Promise<T>):Promise<T>{
  for(let attempt=0;;attempt++)try{return await db.transaction(fn);}catch(error){
    const code=(error as {code?:string})?.code;
    if(!['40001','40P01','23505'].includes(code??''))throw error;
    if(attempt>=2)throw new DomainError('SNAPSHOT_CONCURRENT_CHANGE','This record changed concurrently. Refresh and retry with the same idempotency key.',409);
  }
}
function assertRecoveryBudget(payload:unknown){
  // The protected journal also quotes the canonical event. Bound that encoded
  // object, not only the unescaped candidate JSON, before accepting a command.
  if(Buffer.byteLength(JSON.stringify({eventCanonicalJson:JSON.stringify({payload})}))>7*1024*1024)throw new DomainError('SNAPSHOT_RECOVERY_TOO_LARGE','This operational history exceeds the supported protected snapshot size.',413);
}
function projectedResult(row:SnapshotRow,request:OperationalSnapshotCandidate,at:string):SnapshotRow{
  const receipt=(bytes:string)=>({object:{bucket:request.artifactBucket,key:manifestKey(sha256(bytes)),versionId:'v'.repeat(1024)},sha256:sha256(bytes),byteSize:Buffer.byteLength(bytes),mode:'COMPLIANCE',retainUntil:request.retainUntil,verifiedAt:at});
  const bundle={profile:'packproof.operational-snapshot-result.v1',snapshotId:row.snapshot_id,requestSha256:row.request_sha256,jws:{protected:'x'.repeat(1024),payload:'x'.repeat(8192),signature:'x'.repeat(128)},manifestReceipt:receipt(row.manifest_json),coreReceipt:receipt(request.coreCanonicalJson),priorReceipt:request.priorManifestCanonicalJson===null?null:receipt(request.priorManifestCanonicalJson),artifactReceipts:request.manifest.artifacts.map(a=>({object:a.storage,sha256:a.sha256,byteSize:a.byteSize,mode:'COMPLIANCE',retainUntil:request.retainUntil,verifiedAt:at})),sourceReceipt:'x'.repeat(8192)};
  return {snapshot_id:row.snapshot_id,proof_id:row.proof_id,bundle_json:jcsBytes(bundle).toString(),bundle_sha256:'a'.repeat(64),receipt_json:receipt(jcsBytes(bundle).toString()),accepted_at:at};
}
function validateCoreMembership(manifest:OperationalManifest,core:SnapshotRow){
  snapshotCheck(core.manifestVersion===1&&core.proofId===manifest.proofId&&Array.isArray(core.evidence),'CORE_BINDING_MISMATCH');
  const seen=new Set();for(const evidence of core.evidence){snapshotCheck(snapshotId(evidence.evidenceId)&&!seen.has(evidence.evidenceId),'CORE_MEMBERSHIP_INVALID');seen.add(evidence.evidenceId);const artifact=manifest.artifacts.find(a=>a.artifactId===evidence.evidenceId),omission=manifest.omissions.find(o=>o.artifactId===evidence.evidenceId);snapshotCheck(artifact||omission,'CORE_MEMBERSHIP_MISSING');if(artifact)snapshotCheck(artifact.kind==='CAPTURE_ORIGINAL'&&artifact.sha256===evidence.sha256&&artifact.byteSize===evidence.byteSize&&artifact.evidenceType===evidence.evidenceType&&artifact.contentType===evidence.contentType&&artifact.storage.key===evidence.objectKey&&(!evidence.objectVersionId||artifact.storage.versionId===evidence.objectVersionId),'CORE_ARTIFACT_MISMATCH');}
}
function configured(runtime?:OperationalSnapshotRuntime){if(!runtime)throw new DomainError('OPERATIONAL_SNAPSHOTS_DISABLED','Operational snapshots are waiting for profile qualification.',503);try{runtime.assertReady();}catch{throw new DomainError('OPERATIONAL_SNAPSHOT_QUALIFICATION_UNAVAILABLE','Operational snapshot qualification needs review.',503);}return runtime;}
async function authorize(db:Database,w:RecordWorkspace,proofId:string,runtime:OperationalSnapshotRuntime){
  runtime.assertReady();
  if(w.partner)throw new DomainError('HUMAN_SNAPSHOT_REQUEST_REQUIRED','A current organization owner or administrator must request this snapshot.',403);
  await requireHumanActor(db,w.userId);const current=await requireRecordAccess(db,w,proofId);
  if(!['OWNER','ADMIN'].includes(current.role)||current.environment!==runtime.binding.environment||!runtime.binding.organizationIds.includes(current.organizationId))throw new DomainError('SNAPSHOT_NOT_AVAILABLE','This snapshot is unavailable to the current workspace.',403);
  // A repeatable view alone is insufficient for revocable location grants.
  // Lock the exact authority rows so a concurrent change either waits until
  // this acceptance ends or causes serialization failure and fresh admission.
  const locked=(await db.query<{authorized:boolean}>('SELECT public.lock_operational_snapshot_authority($1,$2,$3,$4,$5) AS authorized',[proofId,current.organizationId,current.environment,current.userId,current.membershipId])).rows[0];
  if(!locked?.authorized)throw new DomainError('SNAPSHOT_NOT_AVAILABLE','This snapshot is unavailable to the current workspace.',403);
  return current;
}
async function authorizeRead(db:Database,w:RecordWorkspace,proofId:string,runtime:OperationalSnapshotRuntime){
  if(!w.partner)return authorize(db,w,proofId,runtime);
  runtime.assertReady();
  if(w.environment!==runtime.binding.environment||!runtime.binding.organizationIds.includes(w.organizationId))throw new DomainError('SNAPSHOT_NOT_AVAILABLE','This snapshot is unavailable to the current workspace.',403);
  await authorizePartnerProof(db,w.authorizationClock??{now:()=>new Date()},w.partner,proofId,'exports:read');
  await requireRecordAccess(db,w,proofId);
  return w;
}
async function fence(tx:Database,generation:string){
  await tx.query('SELECT pg_advisory_xact_lock(1347438146, 36)');
  const row=(await tx.query<{writes_enabled:boolean;generation:string}>('SELECT writes_enabled,generation FROM recovery_writer_fence WHERE singleton=1 FOR UPDATE')).rows[0];
  snapshotCheck(row?.writes_enabled&&row.generation===generation,'WRITER_FENCED');
}
function decode(row:CandidateRow):OperationalSnapshotCandidate{
  snapshotCheck(sha256(row.request_json)===row.request_sha256&&sha256(row.manifest_json)===row.manifest_sha256,'CANDIDATE_CORRUPT');
  const request:OperationalSnapshotCandidate=JSON.parse(row.request_json);validateOperationalManifest(request.manifest);
  snapshotExact(request,['profile','manifest','coreCanonicalJson','priorManifestCanonicalJson','issuer','keyId','artifactBucket','retainUntil','writerGeneration']);
  snapshotCheck(jcsBytes(request).toString()===row.request_json&&jcsBytes(request.manifest).toString()===row.manifest_json&&request.profile==='packproof.operational-snapshot-job.v1'&&request.manifest.snapshotId===row.snapshot_id&&request.manifest.proofId===row.proof_id&&request.manifest.organizationId===row.organization_id&&request.manifest.environment===row.environment&&request.manifest.revision===row.revision&&request.manifest.actor.userId===row.actor_user_id&&request.manifest.actor.membershipId===row.membership_id&&request.manifest.actor.locationId===row.location_id,'CANDIDATE_BINDING_MISMATCH');
  const core=JSON.parse(request.coreCanonicalJson);snapshotCheck(sha256(request.coreCanonicalJson)===request.manifest.core.manifestSha256&&core.proofId===row.proof_id&&core.manifestVersion===1,'CORE_BINDING_MISMATCH');
  validateCoreMembership(request.manifest,core);
  if(request.manifest.priorSnapshot){snapshotCheck(request.priorManifestCanonicalJson!==null,'PRIOR_MISSING');const prior=JSON.parse(request.priorManifestCanonicalJson);validateOperationalManifest(prior);snapshotCheck(sha256(request.priorManifestCanonicalJson)===request.manifest.priorSnapshot.manifestSha256&&prior.snapshotId===request.manifest.priorSnapshot.snapshotId&&prior.organizationId===row.organization_id&&prior.environment===row.environment&&prior.proofId===row.proof_id&&prior.revision<row.revision&&prior.core.manifestSha256===request.manifest.core.manifestSha256,'PRIOR_BINDING_MISMATCH');validateCoreMembership(prior,core);}
  else snapshotCheck(request.priorManifestCanonicalJson===null,'PRIOR_UNDECLARED');
  snapshotCheck(Buffer.byteLength(row.manifest_json)+Buffer.byteLength(request.coreCanonicalJson)+Buffer.byteLength(request.priorManifestCanonicalJson??'')<=16*1024*1024,'METADATA_TOO_LARGE');
  return request;
}
async function freezeRows(tx:Database,proofId:string):Promise<Record<string,SnapshotRow[]>>{
  const rows:Record<string,SnapshotRow[]>={};
  for(const [section,fields] of Object.entries(SNAPSHOT_SECTION_FIELDS)){
    const columns=fields.filter(f=>!['evaluation_status','matching_artifact_ids'].includes(f)).join(',');
    const where=section==='waivers'?'requirement_id IN (SELECT id FROM record_requirements WHERE proof_id=$1)':section==='actions'?'issue_id IN (SELECT id FROM record_issues WHERE proof_id=$1)':'proof_id=$1';
    const table=`record_${section==='links'?'evidence_links':section==='waivers'?'requirement_waivers':section==='actions'?'issue_actions':section}`;
    await frozenTableBound(tx,table,where,proofId);
    const result=(await tx.query<SnapshotRow>(`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY id LIMIT 10001`,[proofId])).rows;
    snapshotCheck(result.length<=10000,'SECTION_LIMIT');rows[section]=normalized(result);
    for(const row of rows[section]){row.created_at=iso(row.created_at);if('due_at'in row)row.due_at=iso(row.due_at);if('sequence'in row)row.sequence=String(row.sequence);}
  }
  return rows;
}
async function frozenTableBound(tx:Database,table:string,where:string,proofId:string){
  // Database aggregation bounds metadata before transferring arbitrary JSONB
  // rows into process memory. Table/where fragments are fixed module constants.
  const size=(await tx.query<{count:string|number;bytes:string|number}>(`SELECT count(*) AS count,COALESCE(sum(octet_length(row_to_json(t)::text)),0) AS bytes FROM ${table} t WHERE ${where}`,[proofId])).rows[0];
  if(Number(size.count)>10000||Number(size.bytes)>4*1024*1024)throw new DomainError('SNAPSHOT_RECOVERY_TOO_LARGE','This operational history exceeds the supported protected snapshot size.',413);
}
async function freezeArtifacts(tx:Database,proofId:string,runtime:OperationalSnapshotRuntime,withheld:Map<string,string>){
  const artifacts:OperationalArtifact[]=[],omissions:OperationalManifest['omissions']=[];
  await frozenTableBound(tx,'evidence','proof_id=$1',proofId);await frozenTableBound(tx,'commerce_stage_evidence','stage_id IN (SELECT id FROM commerce_stages WHERE proof_id=$1)',proofId);await frozenTableBound(tx,'record_source_artifacts','proof_id=$1',proofId);
  const captures=(await tx.query<SnapshotRow>('SELECT e.*,c.recorded_at AS reported_at FROM evidence e LEFT JOIN capture_sessions c ON c.id=e.capture_session_id WHERE e.proof_id=$1 ORDER BY e.id LIMIT 10001',[proofId])).rows;
  const stages=(await tx.query<SnapshotRow>('SELECT e.*,s.actor_user_id AS submitted_by FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE s.proof_id=$1 ORDER BY e.id LIMIT 10001',[proofId])).rows;
  for(const row of [...captures,...stages]){
    const accepted=row.validation_status==='COMMITTED'||row.stage_id&&row.committed_at;
    const reason=withheld.get(row.id);
    if(reason){omissions.push({artifactId:row.id,reason:'WITHHELD',detail:reason});withheld.delete(row.id);continue;}
    if(!accepted||!row.committed_at||!row.sha256||!row.object_version_id||row.object_version_id==='null'){
      omissions.push({artifactId:row.id,reason:row.validation_status==='REJECTED'?'QUARANTINED':accepted?'UNAVAILABLE':'PENDING',detail:accepted?'Accepted original has no exact readable-version commitment.':'Original was not accepted at the frozen evaluation time.'});continue;
    }
    artifacts.push({artifactId:row.id,path:`originals/${row.id}`,kind:'CAPTURE_ORIGINAL',evidenceType:row.evidence_type??'CAPTURE',sha256:row.sha256,byteSize:Number(row.byte_size),contentType:row.content_type,storage:{bucket:runtime.binding.evidenceBucket,key:row.object_key,versionId:row.object_version_id},source:{kind:'CAPTURE',reference:row.capture_session_id??row.stage_id??null,reportedAt:iso(row.reported_at??null),receivedAt:iso(row.created_at)!,acceptedAt:iso(row.committed_at)!,actorId:row.submitted_by??null,connectionId:null,receiptSha256:null},derivation:null});
  }
  const source=(await tx.query<SnapshotRow>(`SELECT a.*,r.object_key,r.object_version_id,r.sha256,r.byte_size,r.content_type AS accepted_content_type,r.accepted_at,s.state AS upload_state,o.state AS operation_state,o.error_code FROM record_source_artifacts a LEFT JOIN record_source_artifact_results r ON r.artifact_id=a.id LEFT JOIN record_source_upload_sessions s ON s.artifact_id=a.id LEFT JOIN record_source_artifact_operations o ON o.artifact_id=a.id WHERE a.proof_id=$1 ORDER BY a.id LIMIT 10001`,[proofId])).rows;
  const links:SnapshotRow[]=[];
  for(const row of source){
    const reason=withheld.get(row.id);if(reason){omissions.push({artifactId:row.id,reason:'WITHHELD',detail:reason});withheld.delete(row.id);}
    else if(!row.accepted_at){const terminal=row.operation_state==='failed'||['rejected','expired'].includes(row.upload_state),quarantined=row.upload_state==='rejected'||terminal&&/MIME|SIGNATURE|HASH|INTEGRITY|CONTENT/.test(row.error_code??'');omissions.push({artifactId:row.id,reason:quarantined?'QUARANTINED':terminal?'UNAVAILABLE':'PENDING',detail:quarantined?'Source original failed acceptance checks.':terminal?'Source original was unavailable for acceptance at the frozen evaluation time.':'Source artifact was not accepted at the frozen evaluation time.'});}
    else artifacts.push({artifactId:row.id,path:`originals/${row.id}`,kind:'SOURCE_ARTIFACT',evidenceType:row.evidence_type??'SOURCE_ARTIFACT',sha256:row.sha256,byteSize:Number(row.byte_size),contentType:row.accepted_content_type,storage:{bucket:runtime.binding.sourceArtifactBucket,key:row.object_key,versionId:row.object_version_id},source:{kind:row.actor_kind==='partner'?'ORGANIZATION_SERVICE_SUBMITTED':'ORGANIZATION_HUMAN_UPLOADED',reference:row.source_artifact_id??null,reportedAt:iso(row.reported_at??null),receivedAt:iso(row.received_at)!,acceptedAt:iso(row.accepted_at)!,actorId:row.actor_kind==='partner'?row.principal_id:row.actor_user_id,connectionId:row.connection_id,receiptSha256:row.receipt_sha256},derivation:null});
    if(row.subject_id)links.push({id:`source_${row.id}`,proof_id:proofId,evidence_id:row.id,subject_id:row.subject_id,reason:'Subject declared with the organization-submitted source artifact.',actor_user_id:row.actor_user_id,created_at:iso(row.received_at)});
  }
  if(withheld.size)throw new DomainError('INVALID_SNAPSHOT_INPUT','A selected artifact is unavailable in this record.',400);
  return {artifacts:artifacts.sort((a,b)=>a.artifactId.localeCompare(b.artifactId)),omissions:omissions.sort((a,b)=>a.artifactId.localeCompare(b.artifactId)),links};
}
/** One consistent accepted command. Human actor, revision, idempotency, candidate,
 * attribution, audit and reconstructable recovery outbox commit together. */
export async function requestOperationalSnapshot(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:unknown,revision:unknown,key:unknown,configuredRuntime?:OperationalSnapshotRuntime){
  const runtime=configured(configuredRuntime);
  if(typeof key!=='string'||!key.trim()||key.length>200)throw new DomainError('IDEMPOTENCY_KEY_REQUIRED','Send a stable Idempotency-Key.',400);
  let withheldPairs:Array<[string,string]>;
  try{
    snapshotExact(input??{},Object.keys(input??{}).length===0?[]:['withheldArtifacts']);
    const withheld=(input as {withheldArtifacts?:unknown})?.withheldArtifacts??[];
    snapshotCheck(Array.isArray(withheld)&&withheld.length<=10000,'WITHHELD_LIMIT');
    withheldPairs=withheld.map(item=>{snapshotExact(item,['artifactId','reason']);snapshotCheck(snapshotId(item.artifactId)&&typeof item.reason==='string'&&item.reason.trim().length>0&&item.reason.length<=2000,'WITHHELD_REASON_REQUIRED');return [item.artifactId,item.reason] as [string,string];}).sort(([a],[b])=>a.localeCompare(b));
    snapshotCheck(new Set(withheldPairs.map(([id])=>id)).size===withheldPairs.length,'DUPLICATE_WITHHELD_ARTIFACT');
  }catch{throw new DomainError('INVALID_SNAPSHOT_INPUT','Use unique artifact IDs with a reason for every intentional omission.',400);}
  const expected=expectedRevision(revision),keyHash=sha256(jcsBytes({proofId,key})),inputHash=sha256(jcsBytes({proofId,revision:expected,withheldArtifacts:withheldPairs}));
  const result=await consistentCommand(db,async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await fence(tx,runtime.binding.writerGeneration);const current=await authorize(tx,w,proofId,runtime);
    const priorKey=(await tx.query<CandidateRow>('SELECT * FROM operational_snapshot_candidates WHERE organization_id=$1 AND environment=$2 AND actor_user_id=$3 AND idempotency_key_hash=$4',[current.organizationId,current.environment,current.userId,keyHash])).rows[0];
    if(priorKey){if(priorKey.input_sha256!==inputHash)throw new DomainError('IDEMPOTENCY_CONFLICT','This idempotency key was already used with different input.',409);decode(priorKey);return {snapshotId:priorKey.snapshot_id,replayed:true};}
    const state=await ensureRecordState(tx,clock,current,proofId);if(state.revision!==expected)throw new DomainError('REVISION_CONFLICT','This record changed. Refresh before creating its snapshot.',412);
    const fullState=(await tx.query<SnapshotRow>('SELECT * FROM record_state WHERE proof_id=$1',[proofId])).rows[0];
    const core=(await tx.query<{canonical_json:string;sha256:string}>(`SELECT m.canonical_json,m.sha256 FROM final_manifests m JOIN proofs p ON p.manifest_id=m.id JOIN recovery_delivery d ON d.operation_id='finalize:'||p.id WHERE p.id=$1 AND p.status='FINALIZED' AND d.state='DURABLE'`,[proofId])).rows[0];
    if(!core||sha256(core.canonical_json)!==core.sha256)throw new DomainError('SNAPSHOT_CORE_NOT_PRESERVED','A preserved finalized core record is required.',409);
    const latest=(await tx.query<CandidateRow>('SELECT * FROM operational_snapshot_candidates WHERE proof_id=$1 ORDER BY revision DESC LIMIT 1',[proofId])).rows[0];
    if(latest&&latest.revision>=expected)throw new DomainError('SNAPSHOT_REVISION_ALREADY_FROZEN','This operational revision already has a frozen snapshot.',409);
    if(latest&&!['READY','FAILED'].includes((await operationalSnapshotStatus(tx,latest.snapshot_id)).state))throw new DomainError('SNAPSHOT_PRIOR_PENDING','The previous snapshot must finish preservation before creating the next.',409);
    // Prior linkage follows accepted signed history. Failed unsigned attempts
    // retain their immutable receipts but never become a signed chain parent.
    const previous=(await tx.query<CandidateRow>(`SELECT c.* FROM operational_snapshot_candidates c JOIN operational_snapshot_results r USING(snapshot_id) JOIN recovery_delivery d ON d.operation_id='operational-snapshot-signed:'||c.snapshot_id WHERE c.proof_id=$1 AND d.state='DURABLE' ORDER BY c.revision DESC LIMIT 1`,[proofId])).rows[0];
    const rows=await freezeRows(tx,proofId),selected=await freezeArtifacts(tx,proofId,runtime,new Map(withheldPairs));
    const coreInventory=JSON.parse(core.canonical_json);for(const artifact of coreInventory.evidence??[])if(!selected.artifacts.some(a=>a.artifactId===artifact.evidenceId)&&!selected.omissions.some(o=>o.artifactId===artifact.evidenceId))selected.omissions.push({artifactId:artifact.evidenceId,reason:'MISSING',detail:'Frozen core original is absent from the accepted operational inventory.'});selected.omissions.sort((a,b)=>a.artifactId.localeCompare(b.artifactId));
    const id=`ops_${sha256(jcsBytes({organizationId:current.organizationId,environment:current.environment,userId:current.userId,keyHash})).slice(0,48)}`;
    const manifest:OperationalManifest={profile:OPERATIONAL_MANIFEST_PROFILE,assertion:'ORGANIZATION_SUBMITTED',snapshotId:id,organizationId:current.organizationId,environment:current.environment,proofId,revision:expected,priorSnapshot:previous?{snapshotId:previous.snapshot_id,manifestSha256:previous.manifest_sha256}:null,core:{manifestSha256:core.sha256},evaluation:{at:clock.now().toISOString(),version:OPERATIONAL_EVALUATION_PROFILE},actor:{userId:current.userId,membershipId:current.membershipId,role:current.role as 'OWNER'|'ADMIN',locationId:fullState.location_id},record:{title:fullState.title,reference:fullState.reference,lifecycle:fullState.lifecycle,reviewState:fullState.review_state,locationId:fullState.location_id,updatedAt:iso(fullState.updated_at)!},entities:rows.entities,links:[...rows.links,...selected.links].sort((a,b)=>a.id.localeCompare(b.id)),requirements:rows.requirements,waivers:rows.waivers,issues:rows.issues,actions:rows.actions,amendments:rows.amendments,artifacts:selected.artifacts,omissions:selected.omissions};
    evaluateSnapshotRequirements(manifest);validateOperationalManifest(manifest);validateCoreMembership(manifest,coreInventory);
    snapshotCheck(jcsBytes(manifest).length+Buffer.byteLength(core.canonical_json)+Buffer.byteLength(previous?.manifest_json??'')<=16*1024*1024,'METADATA_TOO_LARGE');
    const request:OperationalSnapshotCandidate={profile:'packproof.operational-snapshot-job.v1',manifest,coreCanonicalJson:core.canonical_json,priorManifestCanonicalJson:previous?.manifest_json??null,issuer:runtime.binding.issuer,keyId:runtime.binding.keyId,artifactBucket:runtime.binding.artifactBucket,retainUntil:runtime.binding.retainUntil,writerGeneration:runtime.binding.writerGeneration};
    const manifestJson=jcsBytes(manifest).toString(),requestJson=jcsBytes(request).toString();snapshotCheck(Buffer.byteLength(requestJson)<=OPERATIONAL_MAX_METADATA,'REQUEST_TOO_LARGE');
    await tx.query(`INSERT INTO operational_snapshot_candidates(snapshot_id,proof_id,organization_id,environment,revision,actor_user_id,membership_id,location_id,manifest_json,manifest_sha256,request_json,request_sha256,idempotency_key_hash,input_sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[id,proofId,current.organizationId,current.environment,expected,current.userId,current.membershipId,fullState.location_id,manifestJson,sha256(manifestJson),requestJson,sha256(requestJson),keyHash,inputHash,clock.now().toISOString()]);
    await tx.query('INSERT INTO operational_snapshot_delivery(snapshot_id,next_attempt_at) VALUES($1,$2)',[id,clock.now().toISOString()]);
    const audit=await appendAudit(tx,{proofId,actorUserId:current.userId,eventType:'OPERATIONAL_SNAPSHOT_REQUESTED',eventData:{snapshotId:id,revision:expected,manifestSha256:sha256(manifestJson),assertion:'ORGANIZATION_SUBMITTED'},at:clock.now()});
    await tx.query('INSERT INTO proof_outbox(id,proof_id,audit_id,event_type,created_at) VALUES($1,$2,$3,$4,$5)',[`${audit}:record.updated`,proofId,audit,'record.updated',clock.now().toISOString()]);
    const recovery=await buildProofRecoverySnapshot(tx,proofId);assertRecoveryBudget(recovery);
    const future=normalized(recovery);future.rows.operational_snapshot_results.push(projectedResult(future.rows.operational_snapshot_candidates.find((r:SnapshotRow)=>r.snapshot_id===id),request,clock.now().toISOString()));assertRecoveryBudget(future);
    await enqueueRecoveryEvent(tx,clock,{operationId:operationalSnapshotRequestOperation(id),kind:'OPERATIONAL_SNAPSHOT_REQUESTED',proofId,actorUserId:current.userId,payload:recovery});
    return {snapshotId:id,replayed:false};
  });
  await authorize(db,w,proofId,runtime);return {schema:'packproof.operational-snapshot-receipt.v1',...result,...await operationalSnapshotStatus(db,result.snapshotId)};
}
export async function operationalSnapshotStatus(db:Database,id:string){
  const row=(await db.query<{state:string;error_code:string|null}>('SELECT state,error_code FROM operational_snapshot_delivery WHERE snapshot_id=$1',[id])).rows[0];
  if(!row)return {state:'NOT_REQUESTED'};
  if(row.state==='ACCEPTED'){
    const result=(await db.query<{bundle_json:string;bundle_sha256:string}>('SELECT bundle_json,bundle_sha256 FROM operational_snapshot_results WHERE snapshot_id=$1',[id])).rows[0];
    if(!result||sha256(result.bundle_json)!==result.bundle_sha256)return {state:'FAILED',errorCode:'OPERATIONAL_SNAPSHOT_RESULT_CORRUPT',nextAction:'Keep this receipt and ask your workspace administrator to review protected result recovery.'};
    return {state:(await getRecoveryStatus(db,operationalSnapshotResultOperation(id))).status==='PRESERVED'?'READY':'SIGNED_PENDING_DURABILITY'};
  }
  return {state:row.state==='DEAD_LETTER'?'FAILED':'PENDING',...(row.error_code?{errorCode:row.error_code}:{}),nextAction:row.state==='DEAD_LETTER'?'Keep this receipt and the original files. Ask your workspace administrator to review current access, qualification and exact-source protection before maintenance replays this frozen request.':'Keep the original files. Signing and preservation are pending; transient failures retry automatically.'};
}
export async function getOperationalSnapshot(db:Database,w:RecordWorkspace,proofId:string,id:string,configuredRuntime?:OperationalSnapshotRuntime){
  const runtime=configured(configuredRuntime);await authorizeRead(db,w,proofId,runtime);
  const row=(await db.query<CandidateRow>('SELECT * FROM operational_snapshot_candidates WHERE snapshot_id=$1 AND proof_id=$2',[id,proofId])).rows[0];if(!row)throw new DomainError('SNAPSHOT_NOT_FOUND','Snapshot not found.',404);
  const request=decode(row);await authorizeRead(db,w,proofId,runtime);
  return {schema:'packproof.operational-snapshot-receipt.v1',snapshotId:id,proofId,organizationId:row.organization_id,environment:row.environment,revision:row.revision,manifestSha256:row.manifest_sha256,createdAt:iso(row.created_at),assertion:request.manifest.assertion,omissions:request.manifest.omissions,inventory:{includedCount:request.manifest.artifacts.length,omittedCount:request.manifest.omissions.length,artifactBytes:request.manifest.artifacts.reduce((sum,a)=>sum+a.byteSize,0),artifacts:request.manifest.artifacts.slice(0,100).map(({artifactId,path,kind,evidenceType,sha256,byteSize,contentType,source})=>({artifactId,path,kind,evidenceType,sha256,byteSize,contentType,source})),hasMore:request.manifest.artifacts.length>100,limit:100},...await operationalSnapshotStatus(db,id)};
}
export async function listOperationalSnapshots(db:Database,w:RecordWorkspace,proofId:string,configuredRuntime?:OperationalSnapshotRuntime){
  const runtime=configured(configuredRuntime);await authorizeRead(db,w,proofId,runtime);
  const rows=(await db.query<{snapshot_id:string}>('SELECT snapshot_id FROM operational_snapshot_candidates WHERE proof_id=$1 ORDER BY revision DESC LIMIT 51',[proofId])).rows;
  const snapshots=[];for(const row of rows.slice(0,50))snapshots.push(await getOperationalSnapshot(db,w,proofId,row.snapshot_id,runtime));await authorizeRead(db,w,proofId,runtime);
  return {schema:'packproof.operational-snapshot-list.v1',snapshots,hasMore:rows.length>50,limit:50};
}
/** Bounded frozen preview for deliberate inspection. State distinguishes an
 * accepted pending candidate from a preserved signed result. */
export async function previewOperationalSnapshot(db:Database,w:RecordWorkspace,proofId:string,id:string,configuredRuntime?:OperationalSnapshotRuntime){
  const runtime=configured(configuredRuntime);await authorizeRead(db,w,proofId,runtime);const row=(await db.query<CandidateRow>('SELECT * FROM operational_snapshot_candidates WHERE snapshot_id=$1 AND proof_id=$2',[id,proofId])).rows[0];if(!row)throw new DomainError('SNAPSHOT_NOT_FOUND','Snapshot not found.',404);const request=decode(row);await authorizeRead(db,w,proofId,runtime);return {schema:'packproof.operational-snapshot-preview.v1',snapshotId:id,manifest:request.manifest,...await operationalSnapshotStatus(db,id)};
}
async function authorizeCandidate(db:Database,row:CandidateRow,runtime:OperationalSnapshotRuntime){
  const current=await authorize(db,{organizationId:row.organization_id,environment:row.environment as 'live'|'sandbox',userId:row.actor_user_id,membershipId:row.membership_id,tenantId:'',role:'OWNER',enabled:true,locationScoped:false},row.proof_id,runtime);
  snapshotCheck(current.membershipId===row.membership_id,'MEMBERSHIP_REVOKED');
  const currentLocation=(await db.query<{location_id:string|null}>('SELECT location_id FROM record_state WHERE proof_id=$1',[row.proof_id])).rows[0]?.location_id;
  snapshotCheck(currentLocation===row.location_id,'LOCATION_CHANGED');
  snapshotCheck(Date.parse(iso(row.created_at)!)>=Date.parse(runtime.binding.cutoverAt),'CUTOVER_REVOKED');
}
/** Validate the exact protected accepted event, not a database-generated JSON file. */
export async function verifyOperationalSnapshotSource(row:CandidateRow,request:OperationalSnapshotCandidate,sourceReceipt:PreservationReceipt,runtime:Pick<OperationalSnapshotRuntime,'sourceJournal'|'sourceProtection'> & {binding?:Pick<OperationalSnapshotRuntime['binding'],'journalBucket'>}){
  const operationId=operationalSnapshotRequestOperation(row.snapshot_id);snapshotCheck(sourceReceipt.operationId===operationId&&sourceReceipt.objectKey===`recovery/v1/${sha256(operationId)}.json`&&sourceReceipt.objectVersionId&&sourceReceipt.objectVersionId!=='null','SOURCE_RECEIPT_INVALID');
  const saved=await runtime.sourceJournal.store.get(sourceReceipt.objectKey,{versionId:sourceReceipt.objectVersionId});snapshotCheck(saved&&sha256(saved.body)===sourceReceipt.envelopeSha256,'SOURCE_UNAVAILABLE');
  const sourceBucket=runtime.binding?.journalBucket;snapshotCheck(sourceBucket,'SOURCE_BUCKET_REQUIRED');
  const artifact={storage:{bucket:sourceBucket,key:sourceReceipt.objectKey,versionId:sourceReceipt.objectVersionId},sha256:sourceReceipt.envelopeSha256,byteSize:saved.body.length};
  validateEnvelopeReceipt(await runtime.sourceProtection(artifact,request.retainUntil),artifact,request.retainUntil);
  const signedAt=JSON.parse(saved.body.toString()).publishedAt;
  const envelope=await verifyRecoveryEnvelope(saved.body,{trustedPublicKey:id=>runtime.sourceJournal.trustedPublicKey(id,signedAt)},sourceReceipt.eventSha256);
  const event=JSON.parse(envelope.eventCanonicalJson),frozen=event.payload?.rows?.operational_snapshot_candidates?.find((r:CandidateRow)=>r.snapshot_id===row.snapshot_id);
  snapshotCheck(event.kind==='OPERATIONAL_SNAPSHOT_REQUESTED'&&event.operationId===operationId&&event.proofId===row.proof_id&&event.actorUserId===row.actor_user_id&&frozen&&same(normalized(rowWithoutAttempts(row)),frozen)&&frozen.request_json===jcsBytes(request).toString(),'SOURCE_BINDING_MISMATCH');
}
function rowWithoutAttempts(row:CandidateRow){const {attempts:_,...rest}=row;return rest;}
export async function verifyOperationalSnapshotBundle(row:CandidateRow,request:OperationalSnapshotCandidate,bytes:Buffer,runtime:Pick<OperationalSnapshotRuntime,'trustedPublicKey'>,store:Pick<NonNullable<OperationalSnapshotRuntime['worker']>['store'],'verify'>,before?:()=>Promise<void>):Promise<OperationalSnapshotBundle>{
  snapshotCheck(bytes.length<=12*1024*1024,'RESULT_TOO_LARGE');const bundle:OperationalSnapshotBundle=JSON.parse(bytes.toString());snapshotExact(bundle,['profile','snapshotId','requestSha256','jws','manifestReceipt','coreReceipt','priorReceipt','artifactReceipts','sourceReceipt']);
  snapshotCheck(jcsBytes(bundle).equals(bytes)&&bundle.profile==='packproof.operational-snapshot-result.v1'&&bundle.snapshotId===row.snapshot_id&&bundle.requestSha256===row.request_sha256,'RESULT_BINDING_MISMATCH');snapshotExact(bundle.jws,['protected','payload','signature']);
  const envelope=JSON.parse(Buffer.from(base64url.decode(bundle.jws.payload)).toString());validateOperationalEnvelope(envelope);
  const pem=await runtime.trustedPublicKey(request.issuer,request.keyId,envelope.issuedAt);snapshotCheck(pem,'UNTRUSTED_KEY');
  const verified=await flattenedVerify(bundle.jws,await importSPKI(pem,'ES256'),{algorithms:['ES256']});snapshotCheck(same(verified.protectedHeader,{alg:'ES256',kid:request.keyId,typ:OPERATIONAL_SNAPSHOT_TYPE})&&base64url.encode(jcsBytes(verified.protectedHeader))===bundle.jws.protected,'KEY_BINDING_MISMATCH');
  snapshotCheck(Buffer.from(verified.payload).equals(jcsBytes(operationalEnvelope(request.manifest,request.issuer,envelope.issuedAt))),'PAYLOAD_BINDING_MISMATCH');
  const metadata=[{bytes:row.manifest_json,receipt:bundle.manifestReceipt},{bytes:request.coreCanonicalJson,receipt:bundle.coreReceipt},...(request.priorManifestCanonicalJson===null?[]:[{bytes:request.priorManifestCanonicalJson,receipt:bundle.priorReceipt!}])];
  snapshotCheck((request.priorManifestCanonicalJson===null)===(bundle.priorReceipt===null)&&Array.isArray(bundle.artifactReceipts)&&bundle.artifactReceipts.length===request.manifest.artifacts.length,'RECEIPT_MEMBERSHIP_MISMATCH');
  for(const m of metadata){await before?.();const digest=sha256(m.bytes),artifact={storage:m.receipt.object,sha256:digest,byteSize:Buffer.byteLength(m.bytes)};snapshotCheck(m.receipt.object.bucket===request.artifactBucket&&m.receipt.object.key===manifestKey(digest),'MANIFEST_LOCATION_MISMATCH');validateEnvelopeReceipt(m.receipt,artifact,request.retainUntil);validateEnvelopeReceipt(await store.verify(artifact,request.retainUntil),artifact,request.retainUntil);}
  for(let i=0;i<request.manifest.artifacts.length;i++){await before?.();const artifact=request.manifest.artifacts[i];validateEnvelopeReceipt(bundle.artifactReceipts[i],artifact,request.retainUntil);validateEnvelopeReceipt(await store.verify(artifact,request.retainUntil),artifact,request.retainUntil);}
  return bundle;
}
/** Protected background publication; never called with an API signing capability. */
export async function processOperationalSnapshotJob(db:Database,clock:Clock,configuredRuntime?:OperationalSnapshotRuntime):Promise<{processed:number;state?:string}>{
  const runtime=configured(configuredRuntime);snapshotCheck(runtime.worker,'WORKER_REQUIRED');const worker=runtime.worker,token=randomUUID();
  const row=await db.transaction(async tx=>{await fence(tx,runtime.binding.writerGeneration);const candidate=(await tx.query<CandidateRow>(`SELECT c.*,d.attempts FROM operational_snapshot_candidates c JOIN operational_snapshot_delivery d USING(snapshot_id) JOIN recovery_delivery r ON r.operation_id='operational-snapshot-request:'||c.snapshot_id WHERE r.state='DURABLE' AND (d.state='PENDING' OR d.state='LEASED' AND d.lease_until<=$1) AND d.next_attempt_at<=$1 ORDER BY c.created_at,c.snapshot_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,[clock.now().toISOString()])).rows[0];if(!candidate)return null;await tx.query("UPDATE operational_snapshot_delivery SET state='LEASED',lease_token=$2,lease_until=$3,attempts=attempts+1 WHERE snapshot_id=$1",[candidate.snapshot_id,token,new Date(clock.now().getTime()+120000).toISOString()]);return candidate;});
  if(!row)return {processed:0};
  const renew=()=>db.transaction(async tx=>{await fence(tx,runtime.binding.writerGeneration);await authorizeCandidate(tx,row,runtime);const updated=await tx.query("UPDATE operational_snapshot_delivery SET lease_until=$4 WHERE snapshot_id=$1 AND lease_token=$2 AND state='LEASED' AND lease_until>$3",[row.snapshot_id,token,clock.now().toISOString(),new Date(clock.now().getTime()+120000).toISOString()]);snapshotCheck(updated.rowCount===1,'LEASE_LOST');});
  try{
    const request=decode(row);snapshotCheck(request.issuer===runtime.binding.issuer&&request.keyId===runtime.binding.keyId&&request.artifactBucket===runtime.binding.artifactBucket&&request.retainUntil===runtime.binding.retainUntil&&request.writerGeneration===runtime.binding.writerGeneration&&Date.parse(request.retainUntil)>clock.now().getTime(),'ADMISSION_CHANGED');
    await renew();const source=(await db.query<{receipt_json:PreservationReceipt}>('SELECT receipt_json FROM recovery_delivery WHERE operation_id=$1 AND state=\'DURABLE\'',[operationalSnapshotRequestOperation(row.snapshot_id)])).rows[0];snapshotCheck(source,'SOURCE_NOT_DURABLE');await verifyOperationalSnapshotSource(row,request,source.receipt_json,runtime);await renew();
    const key=operationalSnapshotResultKey(row.snapshot_id);let saved=await worker.store.find(request.artifactBucket,key,12*1024*1024);
    if(!saved){
      const preserve=async(bytes:string)=>{await renew();const expectedKey=manifestKey(sha256(bytes)),receipt=await worker.store.preserve(request.artifactBucket,expectedKey,Buffer.from(bytes),request.retainUntil);snapshotCheck(receipt.object.bucket===request.artifactBucket&&receipt.object.key===expectedKey,'MANIFEST_LOCATION_MISMATCH');const artifact={storage:receipt.object,sha256:sha256(bytes),byteSize:Buffer.byteLength(bytes)};validateEnvelopeReceipt(receipt,artifact,request.retainUntil);validateEnvelopeReceipt(await worker.store.verify(artifact,request.retainUntil),artifact,request.retainUntil);return receipt;};
      const manifestReceipt=await preserve(row.manifest_json),coreReceipt=await preserve(request.coreCanonicalJson),priorReceipt=request.priorManifestCanonicalJson===null?null:await preserve(request.priorManifestCanonicalJson),artifactReceipts:ProtectedReceipt[]=[];
      for(const artifact of request.manifest.artifacts){await renew();const receipt=await worker.store.verify(artifact,request.retainUntil);validateEnvelopeReceipt(receipt,artifact,request.retainUntil);artifactReceipts.push(receipt);}
      const envelope=operationalEnvelope(request.manifest,request.issuer,clock.now().toISOString());snapshotCheck(await runtime.trustedPublicKey(request.issuer,request.keyId,envelope.issuedAt),'UNTRUSTED_KEY');await renew();
      const jws=await worker.sign(request.keyId,jcsBytes(envelope));await renew();
      const bundle:OperationalSnapshotBundle={profile:'packproof.operational-snapshot-result.v1',snapshotId:row.snapshot_id,requestSha256:row.request_sha256,jws,manifestReceipt,coreReceipt,priorReceipt,artifactReceipts,sourceReceipt:source.receipt_json};
      await verifyOperationalSnapshotBundle(row,request,jcsBytes(bundle),runtime,worker.store,renew);await renew();await worker.store.preserve(request.artifactBucket,key,jcsBytes(bundle),request.retainUntil);saved=await worker.store.find(request.artifactBucket,key,12*1024*1024);
    }
    snapshotCheck(saved&&saved.object.bucket===request.artifactBucket&&saved.object.key===key,'RESULT_UNAVAILABLE');const verified=await verifyOperationalSnapshotBundle(row,request,saved.body,runtime,worker.store,renew);snapshotCheck(same(verified.sourceReceipt,source.receipt_json),'RESULT_SOURCE_MISMATCH');await verifyOperationalSnapshotSource(row,request,verified.sourceReceipt,runtime);
    await renew();const artifact={storage:saved.object,sha256:sha256(saved.body),byteSize:saved.body.length},receipt=await worker.store.verify(artifact,request.retainUntil);validateEnvelopeReceipt(receipt,artifact,request.retainUntil);
    return await db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await fence(tx,runtime.binding.writerGeneration);await tx.query('SELECT proof_id FROM record_state WHERE proof_id=$1 FOR UPDATE',[row.proof_id]);await authorizeCandidate(tx,row,runtime);const lease=(await tx.query<{state:string;lease_token:string;lease_until:string|Date}>('SELECT state,lease_token,lease_until FROM operational_snapshot_delivery WHERE snapshot_id=$1 FOR UPDATE',[row.snapshot_id])).rows[0];snapshotCheck(lease?.state==='LEASED'&&lease.lease_token===token&&new Date(lease.lease_until).getTime()>clock.now().getTime(),'LEASE_LOST');
      await tx.query('INSERT INTO operational_snapshot_results(snapshot_id,proof_id,bundle_json,bundle_sha256,receipt_json,accepted_at) VALUES($1,$2,$3,$4,$5,$6)',[row.snapshot_id,row.proof_id,saved.body.toString(),artifact.sha256,JSON.stringify(receipt),clock.now().toISOString()]);await tx.query("UPDATE operational_snapshot_delivery SET state='ACCEPTED',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE snapshot_id=$1",[row.snapshot_id]);
      const audit=await appendAudit(tx,{proofId:row.proof_id,actorUserId:row.actor_user_id,eventType:'OPERATIONAL_SNAPSHOT_SIGNED',eventData:{snapshotId:row.snapshot_id,bundleSha256:artifact.sha256,manifestSha256:row.manifest_sha256},at:clock.now()});await tx.query('INSERT INTO proof_outbox(id,proof_id,audit_id,event_type,created_at) VALUES($1,$2,$3,$4,$5)',[`${audit}:record.updated`,row.proof_id,audit,'record.updated',clock.now().toISOString()]);
      const recovery=await buildProofRecoverySnapshot(tx,row.proof_id);assertRecoveryBudget(recovery);await enqueueRecoveryEvent(tx,clock,{operationId:operationalSnapshotResultOperation(row.snapshot_id),kind:'OPERATIONAL_SNAPSHOT_SIGNED',proofId:row.proof_id,actorUserId:row.actor_user_id,payload:recovery});
      runtime.assertReady();snapshotCheck(new Date(lease.lease_until).getTime()>clock.now().getTime(),'LEASE_LOST');return {processed:1,state:'SIGNED_PENDING_DURABILITY'};
    });
  }catch(error){const raw=error instanceof Error?error.message:'',code=error instanceof DomainError&&[403,404].includes(error.httpStatus)?'OPERATIONAL_SNAPSHOT_AUTHORIZATION_REVOKED':/^OPERATIONAL_SNAPSHOT_[A-Z_]+$/.test(raw)?raw:/^ENVELOPE_[A-Z_]*(?:MISMATCH|INVALID|UNTRUSTED|EXPIRED|REQUIRED|UNAVAILABLE)$/.test(raw)?'OPERATIONAL_SNAPSHOT_SOURCE_PROTECTION_MISMATCH':error instanceof DomainError&&error.httpStatus===413?'OPERATIONAL_SNAPSHOT_RECOVERY_SOURCE_TOO_LARGE':'OPERATIONAL_SNAPSHOT_DEPENDENCY_UNAVAILABLE';const terminal=/CORRUPT|MISMATCH|INVALID|REVOKED|UNTRUSTED|CHANGED|EXPIRED|TOO_LARGE/.test(code)||(row.attempts??0)>=7,state=terminal?'DEAD_LETTER':'PENDING';const updated=await db.query("UPDATE operational_snapshot_delivery SET state=$3,error_code=$4,lease_token=NULL,lease_until=NULL,next_attempt_at=$5 WHERE snapshot_id=$1 AND lease_token=$2 AND state='LEASED'",[row.snapshot_id,token,state,code,new Date(clock.now().getTime()+Math.min(60000,1000*2**(row.attempts??0))).toISOString()]);return {processed:code.endsWith('LEASE_LOST')?0:updated.rowCount,state:code.endsWith('LEASE_LOST')?'LEASE_LOST':updated.rowCount?state:'LEASE_LOST'};}
}

/** Export exactly the accepted profile. Omissions remain visible and signed;
 * no later operational state or future artifact is admitted to this package. */
export async function streamOperationalSnapshotPackage(db:Database,w:RecordWorkspace,proofId:string,id:string,configuredRuntime?:OperationalSnapshotRuntime){
  const runtime=configured(configuredRuntime),assertAccess=()=>authorizeRead(db,w,proofId,runtime).then(()=>undefined);await assertAccess();
  const row=(await db.query<CandidateRow>('SELECT * FROM operational_snapshot_candidates WHERE snapshot_id=$1 AND proof_id=$2',[id,proofId])).rows[0];if(!row)throw new DomainError('SNAPSHOT_NOT_FOUND','Snapshot not found.',404);
  if((await operationalSnapshotStatus(db,id)).state!=='READY')throw new DomainError('SNAPSHOT_NOT_READY','Snapshot signing and preservation have not finished.',409);
  const request=decode(row),result=(await db.query<{bundle_json:string;bundle_sha256:string;receipt_json:ProtectedReceipt}>('SELECT bundle_json,bundle_sha256,receipt_json FROM operational_snapshot_results WHERE snapshot_id=$1',[id])).rows[0];snapshotCheck(result&&sha256(result.bundle_json)===result.bundle_sha256,'RESULT_CORRUPT');
  const bundle=await verifyOperationalSnapshotBundle(row,request,Buffer.from(result.bundle_json),runtime,runtime.reader,assertAccess);await verifyOperationalSnapshotSource(row,request,bundle.sourceReceipt,runtime);
  const resultArtifact={storage:result.receipt_json.object,sha256:result.bundle_sha256,byteSize:Buffer.byteLength(result.bundle_json)};snapshotCheck(resultArtifact.storage.bucket===request.artifactBucket&&resultArtifact.storage.key===operationalSnapshotResultKey(id),'RESULT_LOCATION_MISMATCH');validateEnvelopeReceipt(result.receipt_json,resultArtifact,request.retainUntil);validateEnvelopeReceipt(await runtime.reader.verify(resultArtifact,request.retainUntil),resultArtifact,request.retainUntil);
  const descriptor=jcsBytes({schema:'packproof.operational-snapshot-package.v1',snapshotId:id,organizationId:row.organization_id,environment:row.environment,proofId,revision:row.revision,envelopePath:'operational/envelope.jws.json',manifestPath:'operational/manifest.json',timestamp:{state:'NOT_PRESENT'}});
  async function* entries():AsyncIterable<ZipStreamEntry>{
    const metadata:Array<[string,Buffer]>=[['package.json',descriptor],['operational/envelope.jws.json',jcsBytes(bundle.jws)],['operational/manifest.json',Buffer.from(row.manifest_json)],['core/manifest.json',Buffer.from(request.coreCanonicalJson)]];
    if(request.priorManifestCanonicalJson!==null)metadata.push(['operational/prior-manifest.json',Buffer.from(request.priorManifestCanonicalJson)]);
    for(const [name,bytes] of metadata){await assertAccess();yield {name,body:(async function*(){yield bytes;})(),byteSize:bytes.length,sha256:sha256(bytes)};}
    for(const artifact of request.manifest.artifacts){await assertAccess();const opened=await runtime.reader.openExact(artifact.storage);snapshotCheck(opened.versionId===artifact.storage.versionId,'EXACT_VERSION_MISMATCH');yield {name:artifact.path,body:opened.body,byteSize:artifact.byteSize,sha256:artifact.sha256};}
  }
  return streamZip(entries(),{beforeChunk:assertAccess});
}

/** Restore never signs. Exact accepted source/result bytes must verify before
 * the fresh database is installed, and traffic remains closed afterwards. */
export async function verifyRestoredOperationalSnapshots(tables:Record<string,unknown[]>,events:SnapshotRow[],runtime:Pick<OperationalSnapshotRuntime,'trustedPublicKey'|'sourceJournal'|'sourceProtection'|'reader'> & {binding:Pick<OperationalSnapshotRuntime['binding'],'journalBucket'>}){
  const candidates=(tables.operational_snapshot_candidates??[]) as CandidateRow[],results=(tables.operational_snapshot_results??[]) as Array<{snapshot_id:string;proof_id:string;bundle_json:string;bundle_sha256:string;receipt_json:ProtectedReceipt}>;
  for(const row of candidates){const request=decode(row),event=events.find(e=>e.operationId===operationalSnapshotRequestOperation(row.snapshot_id)&&e.proofId===row.proof_id),sourceRow=event?.payload?.rows?.operational_snapshot_candidates?.find((r:CandidateRow)=>r.snapshot_id===row.snapshot_id);snapshotCheck(event?.kind==='OPERATIONAL_SNAPSHOT_REQUESTED'&&event.actorUserId===row.actor_user_id&&sourceRow&&same(rowWithoutAttempts(row),sourceRow),'RESTORE_SOURCE_MISSING');
    const result=results.find(r=>r.snapshot_id===row.snapshot_id);if(!result)continue;
    const accepted=events.find(e=>e.operationId===operationalSnapshotResultOperation(row.snapshot_id)&&e.proofId===row.proof_id)?.payload?.rows?.operational_snapshot_results?.find((r:{snapshot_id:string})=>r.snapshot_id===row.snapshot_id);snapshotCheck(accepted&&same(accepted,result)&&result.proof_id===row.proof_id&&sha256(result.bundle_json)===result.bundle_sha256,'RESTORE_RESULT_MISMATCH');
    const bundle=await verifyOperationalSnapshotBundle(row,request,Buffer.from(result.bundle_json),runtime,runtime.reader);await verifyOperationalSnapshotSource(row,request,bundle.sourceReceipt,runtime);
    const artifact={storage:result.receipt_json.object,sha256:result.bundle_sha256,byteSize:Buffer.byteLength(result.bundle_json)};snapshotCheck(artifact.storage.bucket===request.artifactBucket&&artifact.storage.key===operationalSnapshotResultKey(row.snapshot_id),'RESTORE_RESULT_LOCATION_MISMATCH');validateEnvelopeReceipt(result.receipt_json,artifact,request.retainUntil);validateEnvelopeReceipt(await runtime.reader.verify(artifact,request.retainUntil),artifact,request.retainUntil);
  }
  snapshotCheck(results.every(r=>candidates.some(c=>c.snapshot_id===r.snapshot_id)),'RESTORE_ORPHAN_RESULT');
}
