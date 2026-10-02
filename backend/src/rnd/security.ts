import { randomBytes } from 'node:crypto';
import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { DomainError } from '../domain/errors.js';
import { requireParticipant,loadProof } from '../domain/proof-access.js';
import { requireCommerceAccess } from '../domain/commerce-lifecycle.js';
import type { Database } from '../db/database.js';
import type { RndDeps,Subject,Source } from './types.js';

export const digest=(value:unknown)=>sha256Hex(canonicalize(value));
export const nonce=()=>randomBytes(32).toString('base64url');
export function bad(code:string,message:string,status=422):never {throw new DomainError(code,message,status);}
export const boundedId=(value:unknown,name='id'):string=>typeof value==='string'&&/^[a-zA-Z0-9_:.\/-]{1,180}$/.test(value)?value:bad('RND_INVALID_INPUT',`Invalid ${name}`);
export function onlyKeys(value:unknown,keys:string[]):asserts value is Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))bad('RND_INVALID_INPUT','Unexpected request fields');
}
export async function authorized(db:Database,proofId:string,actor:string) {
 const proof=await loadProof(db,proofId);
 let role:'SELLER'|'BUYER';
 if(proof.workflow_type==='COMMERCE_SALE'&&proof.status==='FINALIZED')role=await requireCommerceAccess(db,proofId,actor);
 else role=(await requireParticipant(db,proofId,actor)).role;
 const ownership=(await db.query<{tenant_id:string}>(`SELECT COALESCE(t.tenant_id,'personal:'||p.user_id) AS tenant_id FROM proof_participants p LEFT JOIN api_tenant_proofs t ON t.proof_id=p.proof_id WHERE p.proof_id=$1 AND p.role='SELLER'`,[proofId])).rows[0];
 if(!ownership)bad('RND_OWNERSHIP_UNAVAILABLE','Canonical ownership is unavailable',409);
 return {proof,role,tenantId:ownership.tenant_id};
}
export async function requireConsent(db:Database,proofId:string,actor:string,purpose='EXPERIMENTAL_ANALYSIS') {
 const row=(await db.query<{granted:boolean}>('SELECT granted FROM rnd_consents WHERE proof_id=$1 AND actor_id=$2 AND purpose=$3 ORDER BY created_at DESC,id DESC LIMIT 1',[proofId,actor,purpose])).rows[0];
 if(!row?.granted)bad('RND_CONSENT_REQUIRED','Explicit current research consent is required',403);
}
export async function subjectFor(deps:RndDeps,db:Database,proofId:string,actor:string,legId='OUTBOUND',write=false):Promise<Subject> {
 const {tenantId,role}=await authorized(db,proofId,actor);
 if(legId==='OUTBOUND'){if(write&&role!=='SELLER')bad('RND_LEG_FORBIDDEN','Only the seller can bind an outbound capture',403);}
 else {
  const stage=(await db.query<{actor_user_id:string}>('SELECT actor_user_id FROM commerce_stages WHERE id=$1 AND proof_id=$2',[legId,proofId])).rows[0];
  if(!stage||write&&stage.actor_user_id!==actor)bad('RND_LEG_FORBIDDEN','The stage does not belong to this actor and Proof',403);
 }
 const found=(await db.query<Record<string,string>>('SELECT * FROM rnd_subjects WHERE proof_id=$1 AND leg_id=$2',[proofId,legId])).rows[0];
 const row=found??{id:newId('rnd_subject'),proof_id:proofId,tenant_id:tenantId,leg_id:legId,package_instance_id:newId('rnd_package')};
 if(!found)await db.query('INSERT INTO rnd_subjects(id,proof_id,tenant_id,leg_id,package_instance_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[row.id,proofId,tenantId,legId,row.package_instance_id,deps.clock.now().toISOString()]);
 return {id:row.id,proofId,tenantId,legId,packageInstanceId:row.package_instance_id};
}
export async function signedRecord(deps:RndDeps,proofId:string,id:string,value:unknown) {
 if(!deps.manifestSigning?.signer)bad('RND_SIGNER_REQUIRED','Configure an isolated research signer before collecting R&D evidence',503);
 const canonicalJson=canonicalize(value),sha256=digest(value);
 const signature=await deps.manifestSigning!.signer!.signManifest({proofId,manifestId:id,canonicalJson,sha256});
 return {canonicalJson,digest:sha256,signature};
}
export async function idempotent<T>(deps:RndDeps,proofId:string,actor:string,operation:string,key:unknown,input:unknown,action:(tx:Database)=>Promise<T>):Promise<T> {
 const id=boundedId(key,'Idempotency-Key'),requestDigest=digest(input);
 return deps.db.transaction(async tx=>{
  await loadProof(tx,proofId,true);
  const {tenantId}=await authorized(tx,proofId,actor);
  const op=`${proofId}:${operation}`,keyHash=sha256Hex(id);
  const prior=(await tx.query<{request_digest:string;response_json:T}>('SELECT request_digest,response_json FROM rnd_idempotency WHERE tenant_id=$1 AND actor_id=$2 AND operation=$3 AND key_hash=$4',[tenantId,actor,op,keyHash])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)bad('RND_IDEMPOTENCY_CONFLICT','Idempotency key was used with different input',409);return prior.response_json;}
  const response=await action(tx);
  await tx.query('INSERT INTO rnd_idempotency(tenant_id,actor_id,operation,key_hash,request_digest,response_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenantId,actor,op,keyHash,requestDigest,JSON.stringify(response),deps.clock.now().toISOString()]);
  return response;
 });
}
export async function resolveSources(deps:RndDeps,db:Database,proofId:string,actor:string,ids:unknown):Promise<Source[]> {
 if(!Array.isArray(ids)||ids.length<1||ids.length>16||new Set(ids).size!==ids.length)bad('RND_INVALID_SOURCES','Supply between 1 and 16 unique committed evidence IDs');
 const result:Source[]=[];
 for(const rawId of ids){
  const evidenceId=boundedId(rawId,'evidence ID');
  let row=(await db.query<Record<string,unknown>>(`SELECT e.id,e.proof_id,e.object_key,e.object_version_id,e.sha256,e.byte_size,e.content_type,e.capture_session_id,e.committed_at,'OUTBOUND' AS leg_id,e.validation_status FROM evidence e WHERE e.id=$1 AND e.proof_id=$2
   UNION ALL SELECT e.id,s.proof_id,e.object_key,e.object_version_id,e.sha256,e.byte_size,e.content_type,e.capture_session_id,e.committed_at,s.id AS leg_id,'COMMITTED' AS validation_status FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE e.id=$1 AND s.proof_id=$2 AND e.discarded_at IS NULL`,[evidenceId,proofId])).rows[0];
  if(!row)row=(await db.query<Record<string,unknown>>(`SELECT c.id,c.proof_id,c.object_key,c.object_version_id,c.sha256,c.byte_length AS byte_size,c.mime_type AS content_type,c.capture_session_id,c.created_at AS committed_at,s.leg_id,'COMMITTED' AS validation_status,'CONCURRENT_SIDECAR' AS relationship,c.frame_reference FROM rnd_capture_sidecars c JOIN rnd_subjects s ON s.id=c.subject_id AND s.proof_id=c.proof_id AND s.tenant_id=c.tenant_id WHERE c.id=$1 AND c.proof_id=$2 AND c.mime_type LIKE 'image/%'`,[evidenceId,proofId])).rows[0];
  if(!row)bad('RND_SOURCE_FORBIDDEN','Evidence is unavailable in this Proof',403);
  if(!row.committed_at||row.validation_status!=='COMMITTED'||!row.sha256)bad('RND_SOURCE_UNCOMMITTED','Analysis requires committed original bytes',409);
  const bytes=Number(row.byte_size);if(!Number.isSafeInteger(bytes)||bytes<1||bytes>128*1024*1024)bad('RND_RESOURCE_LIMIT','Source exceeds the bounded research worker input policy',413);
  const subject=await subjectFor(deps,db,proofId,actor,String(row.leg_id));
  const actual=await deps.objectStore.digest(String(row.object_key),{versionId:row.object_version_id as string|null});
  if(!actual||actual.sha256!==row.sha256||actual.byteSize!==bytes)bad('RND_SOURCE_INTEGRITY','Committed source is unavailable or does not match its commitment',409);
  const source:Source={sourceId:`rnd_source_${evidenceId}`,proofId,tenantId:subject.tenantId,subjectId:subject.id,evidenceId,legId:subject.legId,packageInstanceId:subject.packageInstanceId,captureSessionId:row.capture_session_id as string|null,objectKey:String(row.object_key),objectVersionId:String(row.object_version_id??`content-addressed:${row.sha256}`),sha256:String(row.sha256),byteLength:bytes,mimeType:String(row.content_type),...(row.relationship?{relationship:row.relationship as Source['relationship'],frameReference:row.frame_reference as Record<string,unknown>}: {})};
  await db.query(`INSERT INTO rnd_sources(id,proof_id,tenant_id,subject_id,evidence_id,leg_id,capture_session_id,object_key,object_version_id,sha256,byte_length,mime_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(evidence_id) DO NOTHING`,[source.sourceId,proofId,source.tenantId,subject.id,evidenceId,source.legId,source.captureSessionId,source.objectKey,source.objectVersionId,source.sha256,bytes,source.mimeType,deps.clock.now().toISOString()]);
  result.push(source);
 }
 if(result.reduce((n,s)=>n+s.byteLength,0)>128*1024*1024)bad('RND_RESOURCE_LIMIT','Combined source inventory exceeds the bounded research policy',413);
 return result;
}
