import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { DomainError } from './errors.js';
import { requireSignatureAccess } from './signature.js';
import { requireHumanActor } from '../platform/organization-access.js';
import { requireActiveAccount } from './account-access.js';
import { strictBody } from '../platform/organizations.js';
import { appendAudit } from './audit.js';
import { buildProofRecoverySnapshot, enqueueRecoveryEvent, getRecoveryStatus } from './recovery-journal.js';

const fail=(code:string,message:string,status=409)=>new DomainError(code,message,status);
const STATES=['needs_response','warning_needs_response','under_review','warning_under_review','won','lost','warning_closed','prevented'];
const NETWORKS=['MASTERCARD','VISA','AMEX','DISCOVER','OTHER','UNKNOWN'];
const FACT_FIELDS=['reasonCode','network','lifecycleStatus','providerDeadline','retrievedAt','allowedActions'];
type Facts={reasonCode:string;network:string;lifecycleStatus:string;providerDeadline:string|null;retrievedAt:string;allowedActions:string[]};
type Identity={id:string;proof_id:string;merchant_id:string;environment:string;integration_account_id:string;provider:string;provider_account_id:string;dispute_id:string;payment_id:string;order_line_ids:string[];created_by:string;created_at:string|Date};
type Revision={id:string;claim_case_id:string;proof_id:string;revision:number;previous_sha256:string|null;idempotency_key:string;request_sha256:string;snapshot_json:string;snapshot_sha256:string;recorded_by:string;recorded_at:string|Date};
export interface ClaimSnapshot extends Facts {
 schema:'packproof.claim-case/v1'; claimCaseId:string; proofId:string; merchantId:string; environment:string;
 integrationAccountId:string;provider:string;providerAccountId:string;disputeId:string;paymentId:string;orderLineIds:string[];
 source:'MERCHANT_REPORTED';providerVerification:'UNVERIFIED';apiVersion:'MANUAL_PORTAL';
 revision:number;previousSha256:string|null;recordedBy:string;recordedAt:string;
}
export function requireClaimCaseFeature(){
 if(process.env.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='true'||process.env.PACKPROOF_ORGANIZATIONS_ENABLED!=='true')
  throw fail('CLAIM_EXPORTS_DISABLED','Claim-bound exports have not been enabled.',503);
}
function text(value:unknown,name:string,max=200){
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw fail('CLAIM_INPUT_INVALID',`${name} must be a bounded, nonempty reference.`,400);
 return value;
}
function timestamp(value:unknown,name:string){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw fail('CLAIM_INPUT_INVALID',`${name} must be an explicit UTC timestamp.`,400);
 const normalized=new Date(value).toISOString();
 if(normalized.slice(0,19)!==value.slice(0,19))throw fail('CLAIM_INPUT_INVALID',`${name} must be a valid calendar timestamp.`,400);
 return normalized;
}
function facts(input:Record<string,unknown>,clock:Clock):Facts{
 const reasonCode=text(input.reasonCode,'reasonCode',80),network=text(input.network,'network',30),lifecycleStatus=text(input.lifecycleStatus,'lifecycleStatus',60);
 if(!NETWORKS.includes(network)||!STATES.includes(lifecycleStatus))throw fail('CLAIM_INPUT_INVALID','Use a documented network and lifecycle status.',400);
 const retrievedAt=timestamp(input.retrievedAt,'retrievedAt');
 if(Date.parse(retrievedAt)>clock.now().getTime())throw fail('CLAIM_INPUT_INVALID','retrievedAt cannot be in the future.',400);
 const providerDeadline=input.providerDeadline==null?null:timestamp(input.providerDeadline,'providerDeadline');
 if(!Array.isArray(input.allowedActions)||input.allowedActions.length>2||input.allowedActions.some(v=>v!=='RESPOND'&&v!=='ACCEPT'))throw fail('CLAIM_INPUT_INVALID','Report only documented portal actions.',400);
 return {reasonCode,network,lifecycleStatus,providerDeadline,retrievedAt,allowedActions:[...new Set(input.allowedActions as string[])].sort()};
}
/** This first export cohort is a current human merchant contributor. A service
 * actor, another merchant, buyer or partner membership is not inferred to own it. */
export async function requireClaimAccess(db:Database,actor:string,proofId:string){
 requireClaimCaseFeature();await requireHumanActor(db,actor);await requireActiveAccount(db,actor);
 await requireSignatureAccess(db,proofId,actor);
 const owner=(await db.query<{merchant_id:string;environment:string}>(`SELECT p.merchant_id,p.environment FROM platform_proof_ownership p
 JOIN platform_organizations o ON o.id=p.merchant_id JOIN platform_memberships m ON m.organization_id=o.id JOIN proofs f ON f.id=p.proof_id
 WHERE p.proof_id=$1 AND f.status='FINALIZED' AND m.user_id=$2 AND m.revoked_at IS NULL AND o.enabled=true
 AND m.role IN ('OWNER','ADMIN','OPERATOR','REVIEWER') FOR SHARE OF o,m`,[proofId,actor])).rows[0];
 if(!owner)throw fail('CLAIM_NOT_FOUND','Claim review is unavailable to this account.',404);
 return owner;
}
function decode(c:Identity,r:Revision):ClaimSnapshot{
 if(sha256Hex(r.snapshot_json)!==r.snapshot_sha256)throw fail('CLAIM_INTEGRITY_FAILURE','The recorded case no longer matches its digest.');
 const s=JSON.parse(r.snapshot_json) as ClaimSnapshot;
 if(s.claimCaseId!==c.id||s.proofId!==c.proof_id||s.provider!==c.provider||s.providerAccountId!==c.provider_account_id||s.disputeId!==c.dispute_id||s.paymentId!==c.payment_id||s.revision!==r.revision||s.previousSha256!==r.previous_sha256)throw fail('CLAIM_INTEGRITY_FAILURE','The recorded case identity is inconsistent.');
 return s;
}
async function latest(db:Database,id:string){return (await db.query<Revision>('SELECT * FROM claim_case_revisions WHERE claim_case_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0];}
async function view(db:Database,c:Identity,r:Revision){return {claimCaseId:c.id,revisionId:r.id,revision:r.revision,snapshotSha256:r.snapshot_sha256,snapshot:decode(c,r),preservation:await getRecoveryStatus(db,`claim-revision:${r.id}`),providerSubmission:'UNAVAILABLE' as const};}
async function appendRevision(db:Database,clock:Clock,actor:string,c:Identity,f:Facts,key:string,requestHash:string,prior?:Revision){
 const id=newId('clrev'),at=clock.now().toISOString();
 const snapshot:ClaimSnapshot={schema:'packproof.claim-case/v1',claimCaseId:c.id,proofId:c.proof_id,merchantId:c.merchant_id,environment:c.environment,integrationAccountId:c.integration_account_id,provider:c.provider,providerAccountId:c.provider_account_id,disputeId:c.dispute_id,paymentId:c.payment_id,orderLineIds:c.order_line_ids,...f,source:'MERCHANT_REPORTED',providerVerification:'UNVERIFIED',apiVersion:'MANUAL_PORTAL',revision:(prior?.revision??0)+1,previousSha256:prior?.snapshot_sha256??null,recordedBy:actor,recordedAt:at};
 const json=canonicalize(snapshot),hash=sha256Hex(json);
 const row=(await db.query<Revision>(`INSERT INTO claim_case_revisions(id,claim_case_id,proof_id,revision,previous_sha256,idempotency_key,request_sha256,snapshot_json,snapshot_sha256,recorded_by,recorded_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,c.id,c.proof_id,snapshot.revision,snapshot.previousSha256,key,requestHash,json,hash,actor,at])).rows[0];
 await appendAudit(db,{proofId:c.proof_id,actorUserId:actor,eventType:'CLAIM_CASE_RECORDED',eventData:{claimCaseId:c.id,revisionId:id,snapshotSha256:hash,source:'MERCHANT_REPORTED'},at:clock.now()});
 await enqueueRecoveryEvent(db,clock,{operationId:`claim-revision:${id}`,kind:'CLAIM_CASE_RECORDED',proofId:c.proof_id,actorUserId:actor,payload:await buildProofRecoverySnapshot(db,c.proof_id)});
 return view(db,c,row);
}
export async function createClaimCase(db:Database,clock:Clock,actor:string,proofId:string,input:unknown){
 const b=strictBody(input,['integrationAccountId','disputeId','paymentId','orderLineIds','idempotencyKey',...FACT_FIELDS]);
 const accountId=text(b.integrationAccountId,'integrationAccountId'),disputeId=text(b.disputeId,'disputeId'),paymentId=text(b.paymentId,'paymentId'),key=text(b.idempotencyKey,'idempotencyKey');
 if(!Array.isArray(b.orderLineIds)||b.orderLineIds.length>100)throw fail('CLAIM_INPUT_INVALID','Select up to one hundred affected order lines; an empty list records payment-only scope.',400);
 const orderLineIds=[...new Set(b.orderLineIds.map(v=>text(v,'orderLineId')))].sort(),f=facts(b,clock);
 const requestHash=sha256Hex(canonicalize({accountId,disputeId,paymentId,orderLineIds,...f}));
 return db.transaction(async tx=>{
  const owner=await requireClaimAccess(tx,actor,proofId);
  await tx.query('SELECT pg_advisory_xact_lock(1347438149,hashtext($1))',[proofId]);
  await tx.query('SELECT pg_advisory_xact_lock(1347438149,hashtext($1))',[`${accountId}:${disputeId}`]);
  const retry=(await tx.query<{create_request_sha256:string}>('SELECT create_request_sha256 FROM claim_cases WHERE proof_id=$1 AND created_by=$2 AND create_key=$3',[proofId,actor,key])).rows[0];
  if(retry&&retry.create_request_sha256!==requestHash)throw fail('CLAIM_RETRY_CONFLICT','This creation key already records a different case request.');
  const account=(await tx.query<{provider:string;external_account_id:string}>('SELECT provider,external_account_id FROM platform_integration_accounts WHERE id=$1 AND merchant_id=$2 AND environment=$3',[accountId,owner.merchant_id,owner.environment])).rows[0];
  if(!account||account.provider!=='stripe')throw fail('CLAIM_ACCOUNT_UNSUPPORTED','Choose this merchant registered direct Stripe namespace. No provider connection is implied.',400);
  const payment=await tx.query("SELECT 1 FROM platform_external_bindings WHERE integration_account_id=$1 AND resource_type='PAYMENT' AND external_id=$2 AND proof_id=$3",[accountId,paymentId,proofId]);
  if(!payment.rows[0])throw fail('CLAIM_PAYMENT_SCOPE','The payment is not bound to this Proof and provider account.',400);
  const lines=(await tx.query<{id:string}>('SELECT i.id FROM transaction_items i JOIN proofs p ON p.transaction_id=i.transaction_id WHERE p.id=$1 AND i.id=ANY($2::text[])',[proofId,orderLineIds])).rows;
  if(lines.length!==orderLineIds.length)throw fail('CLAIM_LINE_SCOPE','Each affected order line must belong to this Proof.',400);
  const old=(await tx.query<Identity>('SELECT * FROM claim_cases WHERE integration_account_id=$1 AND dispute_id=$2',[accountId,disputeId])).rows[0];
  if(old){
   if(old.proof_id!==proofId)throw fail('CLAIM_IDENTITY_CONFLICT','This dispute is already bound to a different Proof.');
   const first=(await tx.query<Revision>('SELECT * FROM claim_case_revisions WHERE claim_case_id=$1 AND revision=1',[old.id])).rows[0];
   if(!first||first.request_sha256!==requestHash)throw fail('CLAIM_IDENTITY_CONFLICT','This dispute already exists; append an explicitly reviewed revision.');
   return view(tx,old,first);
  }
  if(Number((await tx.query<{count:string}>('SELECT count(*) AS count FROM claim_cases WHERE proof_id=$1',[proofId])).rows[0].count)>=100)throw fail('CLAIM_LIMIT','This Proof has reached its case limit.',429);
  const c=(await tx.query<Identity>(`INSERT INTO claim_cases(id,proof_id,merchant_id,environment,integration_account_id,provider,provider_account_id,dispute_id,payment_id,order_line_ids,created_by,created_at,create_key,create_request_sha256)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14) RETURNING *`,[newId('claim'),proofId,owner.merchant_id,owner.environment,accountId,account.provider,account.external_account_id,disputeId,paymentId,JSON.stringify(orderLineIds),actor,clock.now().toISOString(),key,requestHash])).rows[0];
  return appendRevision(tx,clock,actor,c,f,key,requestHash);
 });
}
export async function getClaimCase(db:Database,actor:string,proofId:string,id:string){
 await requireClaimAccess(db,actor,proofId);
 const c=(await db.query<Identity>('SELECT * FROM claim_cases WHERE id=$1 AND proof_id=$2',[id,proofId])).rows[0],r=c&&await latest(db,id);
 if(!c||!r)throw fail('CLAIM_NOT_FOUND','Claim case not found.',404);
 return view(db,c,r);
}
export async function listClaimCases(db:Database,actor:string,proofId:string){
 await requireClaimAccess(db,actor,proofId);
 const cases=(await db.query<Identity>('SELECT * FROM claim_cases WHERE proof_id=$1 ORDER BY created_at DESC,id DESC LIMIT 101',[proofId])).rows;
 if(cases.length>100)throw fail('CLAIM_LIST_LIMIT','Use a specific case ID to inspect this larger record.',413);
 return {cases:await Promise.all(cases.map(async c=>view(db,c,await latest(db,c.id))))};
}
export async function reviseClaimCase(db:Database,clock:Clock,actor:string,proofId:string,id:string,input:unknown){
 const b=strictBody(input,['expectedSnapshotSha256','idempotencyKey',...FACT_FIELDS]),key=text(b.idempotencyKey,'idempotencyKey'),f=facts(b,clock);
 if(typeof b.expectedSnapshotSha256!=='string'||! /^[a-f0-9]{64}$/.test(b.expectedSnapshotSha256))throw fail('CLAIM_INPUT_INVALID','The current case digest is required.',400);
 const requestHash=sha256Hex(canonicalize({expectedSnapshotSha256:b.expectedSnapshotSha256,...f}));
 return db.transaction(async tx=>{
  await requireClaimAccess(tx,actor,proofId);
  const c=(await tx.query<Identity>('SELECT * FROM claim_cases WHERE id=$1 AND proof_id=$2 FOR UPDATE',[id,proofId])).rows[0];
  if(!c)throw fail('CLAIM_NOT_FOUND','Claim case not found.',404);
  const replay=(await tx.query<Revision>('SELECT * FROM claim_case_revisions WHERE claim_case_id=$1 AND idempotency_key=$2',[id,key])).rows[0];
  if(replay){if(replay.request_sha256!==requestHash)throw fail('CLAIM_RETRY_CONFLICT','This retry key already records different facts.');return view(tx,c,replay);}
  const prior=await latest(tx,id),s=decode(c,prior);
  if(prior.revision>=100)throw fail('CLAIM_REVISION_LIMIT','This case has reached its revision limit.',429);
  if(prior.snapshot_sha256!==b.expectedSnapshotSha256)throw fail('CLAIM_REVISION_CHANGED','Review the latest case before recording a change.');
  if(Date.parse(f.retrievedAt)<=Date.parse(s.retrievedAt))throw fail('CLAIM_OBSERVATION_STALE','A revision requires a later portal observation.');
  return appendRevision(tx,clock,actor,c,f,key,requestHash,prior);
 });
}
