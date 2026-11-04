import {randomBytes, timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import express, {type Request, type Response, type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {assertPolicyAccessSafe} from '../domain/policy-recovery.js';
import {guardAuthorizedStream} from '../domain/authorized-stream.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {idempotent} from '../platform/idempotency.js';
import {strictBody, reauthorizePartner, auditOrganization, type PartnerActor} from '../platform/organizations.js';
import {protectWebhookResponse, webhookConfigFromEnv} from '../platform/webhooks.js';
import {textField} from '../platform/tenants.js';
import {requireRecordWorkspace, type RecordWorkspace} from './access.js';
import {authorizeCanonicalExport, type CanonicalExportOwner} from './partner-snapshots.js';
import {readCanonicalExport, openCanonicalExport} from './partner-exports.js';
import {getOperationalSnapshot, streamOperationalSnapshotPackage} from './operational-snapshots.js';

type Deps = Pick<AppDependencies,'db'|'clock'|'objectStore'|'envelopes'|'operationalSnapshots'|'devAuth'|'webhookConfig'|'publicBaseUrl'>;
interface Share {
 id:string; proof_id:string; organization_id:string; environment:'sandbox'|'live'; owner_kind:'HUMAN'|'PARTNER'; owner_context:CanonicalExportOwner;
 target_kind:'CANONICAL_EXPORT'|'OPERATIONAL_SNAPSHOT'; target_id:string; selection_sha256:string; token_sha256:string;
 recipient_hint:string|null; created_by:string; created_at:Date|string; expires_at:Date|string; revoked_at:Date|string|null;
}
const who=(owner:CanonicalExportOwner)=>owner.kind==='HUMAN'?{user:owner.workspace.userId,organization:owner.workspace.organizationId,environment:owner.workspace.environment,tenant:owner.workspace.tenantId,identity:`human:${owner.workspace.membershipId}`}:{user:owner.actor.actorUserId,organization:owner.actor.merchantId,environment:owner.actor.environment,tenant:owner.actor.tenantId,identity:`partner:${owner.actor.credentialId}:${owner.actor.delegationGrantId??''}`};
const unavailable=()=>new DomainError('SHARE_UNAVAILABLE','This evidence share is unavailable or expired.',404);
const iso=(v:Date|string)=>new Date(v).toISOString();
function view(row:Share) { return {id:row.id,proofId:row.proof_id,target:{kind:row.target_kind,id:row.target_id},selectionSha256:row.selection_sha256,recipientHint:row.recipient_hint,createdAt:iso(row.created_at),expiresAt:iso(row.expires_at),revokedAt:row.revoked_at?iso(row.revoked_at):null,scope:'FIXED_SNAPSHOT_PACKAGE',permissions:['package:download'],expiryMeaning:'HOSTED_SHARE_ACCESS',issuerAuthorizationRequired:true,downloadedCopiesRemainWithRecipient:true}; }
async function manager(deps:Deps,db:Database,owner:CanonicalExportOwner,proofId:string) {
 if(owner.kind==='PARTNER')await reauthorizePartner(db,deps.clock,owner.actor,'shares:manage');
 await authorizeCanonicalExport(deps,db,owner,proofId);
}
async function target(deps:Deps,owner:CanonicalExportOwner,proofId:string,kind:Share['target_kind'],id:string) {
 if(kind==='CANONICAL_EXPORT') {
  const job=await readCanonicalExport(deps,owner,id);
  if(job.proofId!==proofId||job.state!=='ready'||!job.artifact?.versionBound)throw new DomainError('SHARE_TARGET_NOT_READY','Select an existing ready, version-bound package.',409);
  return {selectionSha256:job.selectionSha256,scope:job.selection.scope,expiresAt:job.expiresAt};
 }
 if(owner.kind!=='HUMAN')throw new DomainError('HUMAN_SNAPSHOT_GRANT_REQUIRED','An administrator must share this operational snapshot.',403);
 const snapshot=await getOperationalSnapshot(deps.db,owner.workspace,proofId,id,deps.operationalSnapshots);
 if(snapshot.state!=='READY')throw new DomainError('SHARE_TARGET_NOT_READY','Wait for the protected operational snapshot to become ready.',409);
 return {selectionSha256:snapshot.manifestSha256,scope:'PROTECTED_OPERATIONAL_SNAPSHOT',expiresAt:null};
}
export async function createSnapshotShare(deps:Deps,owner:CanonicalExportOwner,key:unknown,input:unknown) {
 const b=strictBody(input,['proofId','target','expiresAt','recipientHint','downloadedCopiesAcknowledged']);
 const proofId=textField(b.proofId,'proofId'),t=strictBody(b.target,['kind','id']),id=textField(t.id,'target.id');
 if(!['CANONICAL_EXPORT','OPERATIONAL_SNAPSHOT'].includes(String(t.kind)))throw new DomainError('INVALID_SHARE_TARGET','Select an existing immutable package or operational snapshot.',400);
 if(b.downloadedCopiesAcknowledged!==true)throw new DomainError('SHARE_REVIEW_REQUIRED','Confirm that downloaded copies remain with the recipient.',400);
 const expiry=typeof b.expiresAt==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(b.expiresAt)?Date.parse(b.expiresAt):NaN;
 if(!Number.isFinite(expiry)||expiry<=deps.clock.now().getTime()||expiry>deps.clock.now().getTime()+7*86400000)throw new DomainError('INVALID_SHARE_EXPIRY','Choose a future share expiry within seven days.',400);
 const hint=b.recipientHint==null?null:textField(b.recipientHint,'recipientHint',100),a=who(owner),kind=t.kind as Share['target_kind'];
 await manager(deps,deps.db,owner,proofId);
 const config=deps.webhookConfig??webhookConfigFromEnv();
 if(Buffer.from(config.encryptionKey,'base64').length!==32)throw new DomainError('SECRET_RESPONSE_UNAVAILABLE','Encrypted one-time share responses are not configured.',503);
 const operation=`snapshot-share:${a.environment}:${a.identity}`;
 const result=await idempotent(deps.db,deps.clock,a.tenant,operation,key,b,async tx=>{
  await manager(deps,tx,owner,proofId);
  await tx.query('SELECT pg_advisory_xact_lock(1347438152,hashtext($1))',[proofId]);
  const active=(await tx.query<{n:string}>('SELECT count(*)::text n FROM record_snapshot_shares WHERE proof_id=$1 AND revoked_at IS NULL AND expires_at>$2',[proofId,deps.clock.now().toISOString()])).rows[0];
  if(Number(active.n)>=100)throw new DomainError('SHARE_LIMIT_REACHED','Revoke an existing active share before creating another.',409);
  const selection=await target({...deps,db:tx},owner,proofId,kind,id);
  if(selection.expiresAt&&expiry>Date.parse(selection.expiresAt))throw new DomainError('SHARE_EXCEEDS_DOWNLOAD_AVAILABILITY','Share access must end before the stored package expires.',409);
  const shareId=newId('record_share'),token=`pps_${randomBytes(32).toString('base64url')}`,at=deps.clock.now().toISOString();
  await tx.query('INSERT INTO record_snapshot_shares(id,proof_id,organization_id,environment,owner_kind,owner_context,target_kind,target_id,selection_sha256,token_sha256,recipient_hint,created_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)',[shareId,proofId,a.organization,a.environment,owner.kind,canonicalize(owner),kind,id,selection.selectionSha256,sha256Hex(token),hint,a.user,at,new Date(expiry).toISOString()]);
  await auditOrganization(tx,deps.clock,{...(owner.kind==='HUMAN'?{userId:a.user,merchantId:a.organization}:{actor:owner.actor}),requestId:shareId,operation:'RECORD_SNAPSHOT_SHARED',resourceId:proofId});
  return {id:shareId,token};
 },protectWebhookResponse(`${a.tenant}:${operation}:${sha256Hex(String(key))}`,config));
 const row=(await deps.db.query<Share>('SELECT * FROM record_snapshot_shares WHERE id=$1',[result.value.id])).rows[0];
 await manager(deps,deps.db,owner,proofId);
 if(!row||row.revoked_at||Date.parse(iso(row.expires_at))<=deps.clock.now().getTime())throw unavailable();
 return {...result,value:{...view(row),token:result.value.token,reviewPath:`/review-package#${result.value.token}`}};
}
export async function listSnapshotShares(deps:Deps,owner:CanonicalExportOwner,proofId:string) {
 await manager(deps,deps.db,owner,proofId);const a=who(owner);
 const rows=(await deps.db.query<Share>('SELECT * FROM record_snapshot_shares WHERE proof_id=$1 AND organization_id=$2 AND environment=$3 ORDER BY created_at DESC,id DESC LIMIT 100',[proofId,a.organization,a.environment])).rows;
 await manager(deps,deps.db,owner,proofId);return {shares:rows.map(view),limit:100};
}
export async function revokeSnapshotShare(deps:Deps,owner:CanonicalExportOwner,id:string,input:unknown) {
 const b=strictBody(input,['reason']),reason=textField(b.reason,'reason',1000),a=who(owner);
 return deps.db.transaction(async tx=>{
  const row=(await tx.query<Share>('SELECT * FROM record_snapshot_shares WHERE id=$1 AND organization_id=$2 AND environment=$3 FOR UPDATE',[id,a.organization,a.environment])).rows[0];
  if(!row)throw unavailable();await manager(deps,tx,owner,row.proof_id);
  if(!row.revoked_at){await tx.query('UPDATE record_snapshot_shares SET revoked_at=$2,revoked_by=$3,revoke_reason=$4 WHERE id=$1',[id,deps.clock.now().toISOString(),a.user,reason]);await auditOrganization(tx,deps.clock,{...(owner.kind==='HUMAN'?{userId:a.user,merchantId:a.organization}:{actor:owner.actor}),requestId:newId('req'),operation:'RECORD_SNAPSHOT_SHARE_REVOKED',resourceId:row.proof_id});}
  return {id,revoked:true,downloadedCopiesRemainWithRecipient:true};
 });
}
async function resolve(deps:Deps,token:unknown) {
 await assertPolicyAccessSafe(deps.db);
 if(typeof token!=='string'||!/^pps_[A-Za-z0-9_-]{43}$/.test(token))throw unavailable();
 const digest=sha256Hex(token),row=(await deps.db.query<Share>('SELECT * FROM record_snapshot_shares WHERE token_sha256=$1',[digest])).rows[0];
 if(!row||!timingSafeEqual(Buffer.from(row.token_sha256,'hex'),Buffer.from(digest,'hex'))||row.revoked_at||Date.parse(iso(row.expires_at))<=deps.clock.now().getTime())throw unavailable();
 try {await manager(deps,deps.db,row.owner_context,row.proof_id);const selection=await target(deps,row.owner_context,row.proof_id,row.target_kind,row.target_id);if(selection.selectionSha256!==row.selection_sha256)throw unavailable();}
 catch(error){if(error instanceof DomainError&&error.httpStatus<500)throw unavailable();throw error;}
 return row;
}
export async function readSnapshotShare(deps:Deps,token:unknown) {const row=await resolve(deps,token);return {id:row.id,scope:'FIXED_SNAPSHOT_PACKAGE',targetKind:row.target_kind,selectionSha256:row.selection_sha256,expiresAt:iso(row.expires_at),permissions:['package:download'],liveRecordAvailable:false,downloadedCopiesRemainWithRecipient:true};}
export async function openSnapshotShare(deps:Deps,token:unknown) {
 const row=await resolve(deps,token);let source:Readable;
 if(row.target_kind==='CANONICAL_EXPORT')source=(await openCanonicalExport(deps,row.owner_context,row.target_id)).body;
 else source=Readable.from(await streamOperationalSnapshotPackage(deps.db,(row.owner_context as {kind:'HUMAN';workspace:RecordWorkspace}).workspace,row.proof_id,row.target_id,deps.operationalSnapshots));
 try {await resolve(deps,token);return guardAuthorizedStream(source,()=>resolve(deps,token).then(()=>undefined),{maximumBytesBetweenChecks:65536});}catch(error){source.destroy();throw error;}
}
const run=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r,s).catch(e=>{if(s.headersSent||s.destroyed)s.destroy();else n(e);});
export function createSnapshotSharesRouter(deps:AppDependencies,human:boolean) {
 const router=express.Router();
 async function owner(r:Request):Promise<CanonicalExportOwner> {if(!human)return {kind:'PARTNER',actor:(r as Request&{partnerActor:PartnerActor}).partnerActor};const a=await deps.auth.authenticate(r.headers);return {kind:'HUMAN',workspace:await requireRecordWorkspace(deps.db,a.userId,r.query.organizationId,r.query.environment,true)};}
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
 router.post('/shares',run(async(r,s)=>{const result=await createSnapshotShare(deps,await owner(r),r.header('Idempotency-Key'),r.body);s.setHeader('Idempotency-Replayed',String(result.replayed));s.status(201).json(result.value);}));
 router.get(human?'/:proofId/shares':'/proofs/:proofId/shares',run(async(r,s)=>{s.json(await listSnapshotShares(deps,await owner(r),r.params.proofId));}));
 router.post('/shares/:shareId/revoke',run(async(r,s)=>{s.json(await revokeSnapshotShare(deps,await owner(r),r.params.shareId,r.body));}));
 return router;
}
export function createPublicSnapshotSharesRouter(deps:AppDependencies) {
 const router=express.Router(),token=(r:Request)=>r.header('Authorization')?.replace(/^Bearer\s+/i,'');
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');s.setHeader('Referrer-Policy','no-referrer');s.setHeader('X-Content-Type-Options','nosniff');n();});
 router.get('/',run(async(r,s)=>{s.json(await readSnapshotShare(deps,token(r)));}));
 router.get('/package',run(async(r,s)=>{const stream=await openSnapshotShare(deps,token(r));s.setHeader('Content-Type','application/zip');s.setHeader('Content-Disposition','attachment; filename="packproof-shared-snapshot.zip"');await pipeline(stream,s);}));
 return router;
}
