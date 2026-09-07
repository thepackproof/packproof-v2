import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { canonicalize } from '../canonical.js';
import { appendAudit } from '../domain/audit.js';
import { assertPolicyAccessSafe } from '../domain/policy-recovery.js';
import { requireActiveAccount } from '../domain/account-access.js';
import { streamPreservedObject } from '../domain/evidence.js';
import { guardDisclosureStream } from '../domain/disclosure-stream.js';
export interface SupportAccessPolicy { approverUserIds:readonly string[]; readerUserIds:readonly string[]; }
export function parseSupportAccessPolicy(env:NodeJS.ProcessEnv=process.env):SupportAccessPolicy {
  const ids=(value:string|undefined)=>{const values=(value??'').split(',').map(value=>value.trim()).filter(Boolean);if(values.length>100||values.some(value=>!/^[A-Za-z0-9:_-]{1,200}$/.test(value)))throw new Error('Support roles require explicit internal account IDs');return [...new Set(values)];};
  return {approverUserIds:ids(env.PACKPROOF_SUPPORT_APPROVER_IDS),readerUserIds:ids(env.PACKPROOF_SUPPORT_READER_IDS)};
}
type Grant={id:string;proof_id:string;support_user_id:string;approved_by:string;scope:'METADATA'|'EVIDENCE_READ';evidence_ids:string[];reason:string;issue_reference:string;operation_id:string;created_at:Date|string;expires_at:Date|string};
const unavailable=()=>new DomainError('SUPPORT_ACCESS_UNAVAILABLE','Support access is unavailable',403);
const inputError=()=>new DomainError('INVALID_SUPPORT_GRANT','Provide a reviewed issue, reason, explicit reader and scope with expiry within one hour',400);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function reason(value:unknown):string {if(typeof value!=='string'||value.trim().length<10||value.trim().length>1000)throw inputError();return value.trim();}
function assertApprover(policy:SupportAccessPolicy,actor:string){if(!policy.approverUserIds.includes(actor))throw unavailable();}
function view(row:Grant){return {grantId:row.id,proofId:row.proof_id,supportUserId:row.support_user_id,approvedBy:row.approved_by,scope:row.scope,evidenceIds:row.evidence_ids,reason:row.reason,issueReference:row.issue_reference,createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};}
async function audit(db:Database,clock:Clock,grant:Grant,actor:string,event:string,operationId:string,evidenceId:string|null=null){
  await db.query('INSERT INTO support_access_audit(id,grant_id,actor_user_id,event_type,evidence_id,operation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[newId('support_audit'),grant.id,actor,event,evidenceId,operationId,clock.now().toISOString()]);
  await appendAudit(db,{proofId:grant.proof_id,actorUserId:actor,eventType:`SUPPORT_${event}`,eventData:{grantId:grant.id,scope:grant.scope,evidenceId,issueReference:grant.issue_reference},at:clock.now()});
}
export async function issueSupportGrant(db:Database,clock:Clock,policy:SupportAccessPolicy,actor:string,input:unknown){
  assertApprover(policy,actor);
  if(!object(input)||Object.keys(input).some(key=>!['proofId','supportUserId','scope','evidenceIds','reason','issueReference','operationId','expiresAt'].includes(key)))throw inputError();
  if(typeof input.proofId!=='string'||typeof input.supportUserId!=='string'||input.supportUserId===actor||!policy.readerUserIds.includes(input.supportUserId)||!['METADATA','EVIDENCE_READ'].includes(String(input.scope))||typeof input.issueReference!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_.\/-]{2,199}$/.test(input.issueReference)||typeof input.operationId!=='string'||!/^[A-Za-z0-9:_-]{8,200}$/.test(input.operationId)||typeof input.expiresAt!=='string')throw inputError();
  const justification=reason(input.reason),expiresAt=new Date(input.expiresAt),now=clock.now();
  if(!Number.isFinite(expiresAt.getTime())||expiresAt<=now||expiresAt.getTime()>now.getTime()+3600000)throw inputError();
  const evidenceIds=input.evidenceIds??[];
  if(!Array.isArray(evidenceIds)||evidenceIds.some(id=>typeof id!=='string')||evidenceIds.length>10||new Set(evidenceIds).size!==evidenceIds.length||input.scope==='METADATA'&&evidenceIds.length!==0||input.scope==='EVIDENCE_READ'&&!evidenceIds.length)throw inputError();
  const selected=[...evidenceIds].sort();
  return db.transaction(async tx=>{
    await assertPolicyAccessSafe(tx);
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
    await requireActiveAccount(tx,actor);
    await requireActiveAccount(tx,input.supportUserId as string);
    const existing=(await tx.query<Grant>('SELECT * FROM support_access_grants WHERE approved_by=$1 AND operation_id=$2',[actor,input.operationId])).rows[0];
    if(existing){if(existing.proof_id!==input.proofId||existing.support_user_id!==input.supportUserId||existing.scope!==input.scope||existing.reason!==justification||existing.issue_reference!==input.issueReference||new Date(existing.expires_at).toISOString()!==expiresAt.toISOString()||canonicalize(existing.evidence_ids)!==canonicalize(selected))throw new DomainError('SUPPORT_OPERATION_CONFLICT','This operation already authorized a different scope',409);return view(existing);}
    if(!(await tx.query('SELECT id FROM users WHERE id=$1',[input.supportUserId])).rows[0]||!(await tx.query('SELECT id FROM proofs WHERE id=$1',[input.proofId])).rows[0])throw unavailable();
    for(const id of selected)if(!(await tx.query("SELECT id FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status='COMMITTED'",[id,input.proofId])).rows[0])throw unavailable();
    const grant=(await tx.query<Grant>(`INSERT INTO support_access_grants(id,proof_id,support_user_id,approved_by,scope,evidence_ids,reason,issue_reference,operation_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[newId('support'),input.proofId,input.supportUserId,actor,input.scope,JSON.stringify(selected),justification,input.issueReference,input.operationId,now.toISOString(),expiresAt.toISOString()])).rows[0];
    await audit(tx,clock,grant,actor,'GRANTED',input.operationId as string);return view(grant);
  });
}
export async function authorizeSupportGrant(db:Database,clock:Clock,policy:SupportAccessPolicy,actor:string,grantId:string,evidenceId?:string):Promise<Grant>{
  if(!policy.readerUserIds.includes(actor))throw unavailable();
  await assertPolicyAccessSafe(db);
  await requireActiveAccount(db,actor);
  const grant=(await db.query<Grant>('SELECT g.* FROM support_access_grants g WHERE g.id=$1 AND g.support_user_id=$2 AND g.expires_at>$3 AND NOT EXISTS(SELECT 1 FROM support_access_revocations r WHERE r.grant_id=g.id)',[grantId,actor,clock.now().toISOString()])).rows[0];
  if(!grant||evidenceId&&(grant.scope!=='EVIDENCE_READ'||!grant.evidence_ids.includes(evidenceId)))throw unavailable();
  return grant;
}
export async function revokeSupportGrant(db:Database,clock:Clock,policy:SupportAccessPolicy,actor:string,grantId:string,input:unknown){
  if(!object(input))throw inputError();const justification=reason(input.reason);
  return db.transaction(async tx=>{
    await assertPolicyAccessSafe(tx);
    await requireActiveAccount(tx,actor);
    const grant=(await tx.query<Grant>('SELECT * FROM support_access_grants WHERE id=$1 FOR UPDATE',[grantId])).rows[0];
    if(!grant||!policy.approverUserIds.includes(actor)&&!(policy.readerUserIds.includes(actor)&&grant.support_user_id===actor))throw unavailable();
    const inserted=await tx.query('INSERT INTO support_access_revocations(grant_id,actor_user_id,reason,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(grant_id) DO NOTHING',[grantId,actor,justification,clock.now().toISOString()]);
    if(inserted.rowCount)await audit(tx,clock,grant,actor,'REVOKED',`revoke:${grantId}`);
    return {grantId,revoked:true};
  });
}
export async function listSupportGrants(db:Database,clock:Clock,policy:SupportAccessPolicy,actor:string){
  if(!policy.readerUserIds.includes(actor)&&!policy.approverUserIds.includes(actor))throw unavailable();await assertPolicyAccessSafe(db);await requireActiveAccount(db,actor);
  const rows=(await db.query<Grant & {revoked_at:Date|string|null}>('SELECT g.*,r.created_at AS revoked_at FROM support_access_grants g LEFT JOIN support_access_revocations r ON r.grant_id=g.id WHERE g.support_user_id=$1 OR g.approved_by=$1 ORDER BY g.created_at DESC,g.id DESC LIMIT 100',[actor])).rows;
  return {grants:rows.map(row=>({...view(row),revokedAt:row.revoked_at?new Date(row.revoked_at).toISOString():null})),readOnly:true};
}
export async function readSupportMetadata(db:Database,clock:Clock,policy:SupportAccessPolicy,actor:string,grantId:string,operationId:string){
  return db.transaction(async tx=>{
    const grant=await authorizeSupportGrant(tx,clock,policy,actor,grantId);
    const proof=(await tx.query<{id:string;status:string;created_at:Date|string;finalized_at:Date|string|null}>('SELECT id,status,created_at,finalized_at FROM proofs WHERE id=$1',[grant.proof_id])).rows[0];
    if(!proof)throw unavailable();
    const counts=(await tx.query<{validation_status:string;count:number}>("SELECT validation_status,COUNT(*)::int AS count FROM evidence WHERE proof_id=$1 GROUP BY validation_status",[grant.proof_id])).rows;
    await audit(tx,clock,grant,actor,'METADATA_READ',operationId);
    await authorizeSupportGrant(tx,clock,policy,actor,grantId);
    return {proofId:proof.id,status:proof.status,createdAt:new Date(proof.created_at).toISOString(),finalizedAt:proof.finalized_at?new Date(proof.finalized_at).toISOString():null,evidenceCounts:counts,scope:grant.scope,expiresAt:new Date(grant.expires_at).toISOString(),contentAccess:grant.scope==='EVIDENCE_READ'?grant.evidence_ids:[],readOnly:true};
  });
}
export async function readSupportEvidence(db:Database,clock:Clock,store:ObjectStore,policy:SupportAccessPolicy,actor:string,grantId:string,evidenceId:string,operationId:string,range?:string){
  const grant=await authorizeSupportGrant(db,clock,policy,actor,grantId,evidenceId);
  const row=(await db.query<{id:string;object_key:string;object_version_id:string|null;content_type:string;sha256:string;byte_size:string|number}>("SELECT id,object_key,object_version_id,content_type,sha256,byte_size FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status='COMMITTED'",[evidenceId,grant.proof_id])).rows[0];
  if(!row)throw unavailable();
  await db.transaction(async tx=>{await authorizeSupportGrant(tx,clock,policy,actor,grantId,evidenceId);await audit(tx,clock,grant,actor,'EVIDENCE_READ_STARTED',operationId,evidenceId);});
  const result=await streamPreservedObject(store,row,range);
  try{
    await authorizeSupportGrant(db,clock,policy,actor,grantId,evidenceId);
    if(result.body)result.body=guardDisclosureStream(result.body,async()=>{await authorizeSupportGrant(db,clock,policy,actor,grantId,evidenceId);},{maximumBytesBetweenChecks:64*1024,maximumMsBetweenChecks:1000,maximumLifetimeMs:Math.max(1,new Date(grant.expires_at).getTime()-clock.now().getTime()),now:()=>clock.now().getTime()});
    return result;
  }catch(error){result.body?.destroy();throw error;}
}
