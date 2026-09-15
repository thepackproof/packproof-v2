import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {DomainError} from '../domain/errors.js';
import {IntegrationError} from '../domain/integration-errors.js';
import {createTransaction} from '../domain/transactions.js';
import {createOrGetProof} from '../domain/create-proof.js';
import {appendAudit} from '../domain/audit.js';
import {resolvePackingStationTarget} from '../domain/packing-station-resolve.js';
import {prepareExistingIntakeOrder} from './context.js';
import {parseSubmissionEnvelope,classifySubmission,strictRecord,type SubmissionEnvelope,type SubmissionHints} from './submissions-contract.js';
import {intakeEnabled,type IntakeRuntimeConfig} from './runtime-config.js';
import type {CommerceSyncDependencies} from '../domain/commerce-fulfillment-sync.js';

export type SubmissionState='RECEIVED'|'RESOLVING'|'READY'|'NEEDS_CONNECTION'|'NEEDS_SELECTION'|'INVALID'|'RETRYABLE_FAILED'|'DISMISSED';
export interface SubmissionCandidate {candidateId:string;transactionId:string;orderReference:string;itemSummary:string;provider:string|null}
interface SubmissionRow {
 id:string;actor_user_id:string;client_submission_id:string;session_id:string|null;request_hash:string;resolution_hash:string|null;
 surface:SubmissionEnvelope['surface'];state:SubmissionState;hints:SubmissionHints;raw_text:string|null;raw_expires_at:Date|string;
 transaction_id:string|null;proof_id:string|null;next_action:string;error_code:string|null;message:string;candidates:SubmissionCandidate[];
 attempt_count:number;lease_token:string|null;lease_expires_at:Date|string|null;updated_at:Date|string;
}
export function submissionView(row:SubmissionRow,restricted=false) {
 return {submissionId:row.id,clientSubmissionId:row.client_submission_id,state:row.state,transactionId:row.transaction_id,proofId:row.proof_id,nextAction:row.next_action,
  retryable:['RECEIVED','RESOLVING','RETRYABLE_FAILED'].includes(row.state),errorCode:row.error_code,updatedAt:new Date(row.updated_at).toISOString(),candidates:restricted?[]:row.candidates,message:row.message};
}
async function ownedRow(db:Database,actor:string,id:string,sessionId?:string,lock=false):Promise<SubmissionRow> {
 const row=(await db.query<SubmissionRow>(`SELECT * FROM intake_submissions WHERE id=$1 AND actor_user_id=$2${sessionId?' AND session_id=$3':''}${lock?' FOR UPDATE':''}`,[id,actor,...(sessionId?[sessionId]:[])])).rows[0];
 if(!row)throw new DomainError('INTAKE_SUBMISSION_NOT_FOUND','This saved order is not available.',404);return row;
}
export async function getIntakeSubmission(db:Database,actor:string,id:string,sessionId?:string) {return submissionView(await ownedRow(db,actor,id,sessionId),!!sessionId);}
export async function listIntakeSubmissions(db:Database,actor:string) {
 const rows=(await db.query<SubmissionRow>("SELECT * FROM intake_submissions WHERE actor_user_id=$1 AND state NOT IN ('READY','DISMISSED') ORDER BY updated_at DESC,id DESC LIMIT 50",[actor])).rows;
 return {submissions:rows.map(row=>submissionView(row))};
}
async function validateHintConnection(db:Database,actor:string,hints:SubmissionHints) {
 if(!hints.connectionId)return;
 const row=(await db.query<{provider:string;external_account_reference:string}>('SELECT provider,external_account_reference FROM integration_connections WHERE id=$1 AND owner_user_id=$2',[hints.connectionId,actor])).rows[0];
 if(!row||hints.provider&&hints.provider!==row.provider||hints.accountReference&&hints.accountReference!==row.external_account_reference||hints.storeHandle&&row.external_account_reference!==hints.storeHandle&&row.external_account_reference!==`${hints.storeHandle}.myshopify.com`)
  throw new DomainError('INTAKE_CONNECTION_NOT_FOUND','Choose the connected account that owns this order.',404);
 // Persist the stable server-owned account, so changing a connection row never changes a queued input's destination.
 hints.accountReference=row.external_account_reference;
}
/** Persist before doing any resolution. A lost response always reuses the actor/client receipt. */
export async function submitIntakeSubmission(db:Database,clock:Clock,actor:string,input:unknown,config:IntakeRuntimeConfig|undefined,sessionId?:string) {
 const envelope=parseSubmissionEnvelope(input),hash=sha256Hex(canonicalize(envelope)),hints=classifySubmission(envelope);
 const accepted=await db.transaction(async tx=>{
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
  const replay=(await tx.query<SubmissionRow>('SELECT * FROM intake_submissions WHERE actor_user_id=$1 AND client_submission_id=$2',[actor,envelope.clientSubmissionId])).rows[0];
  if(replay){
   if(sessionId&&replay.session_id!==sessionId)throw new DomainError('INTAKE_SUBMISSION_NOT_FOUND','This saved order is not available.',404);
   if(replay.request_hash!==hash)throw new DomainError('IDEMPOTENCY_CONFLICT','This submission ID already belongs to different shared content.',409);
   return {row:replay,replayed:true};
  }
  if(!intakeEnabled(config,actor))throw new DomainError('INTAKE_PAUSED','New order intake is paused. Your saved recording remains available.',409);
  await validateHintConnection(tx,actor,hints);
  const now=clock.now(),id=newId('intake_submission');
  const row=(await tx.query<SubmissionRow>(`INSERT INTO intake_submissions(id,actor_user_id,client_submission_id,session_id,request_hash,surface,state,hints,raw_text,raw_expires_at,next_action,message,created_at,updated_at,next_attempt_at)
   VALUES($1,$2,$3,$4,$5,$6,'RECEIVED',$7::jsonb,$8,$9,'RETRY','Order saved. Preparing your packing queue.',$10,$10,$10) RETURNING *`,
   [id,actor,envelope.clientSubmissionId,sessionId??null,hash,envelope.surface,JSON.stringify(hints),envelope.payload.text,new Date(now.getTime()+7*86400000).toISOString(),now.toISOString()])).rows[0];
  return {row,replayed:false};
 });
 if(accepted.replayed)return {submission:submissionView(accepted.row,!!sessionId),replayed:true};
 // No provider request on the short extension request. Exact API retrieval is durable worker work.
 await processSubmission(db,clock,actor,accepted.row.id,undefined,false);
 return {submission:await getIntakeSubmission(db,actor,accepted.row.id,sessionId),replayed:false};
}
interface MatchRow {transaction_id:string;external_reference:string|null;item_title:string|null;provider:string|null}
async function findCandidates(db:Database,actor:string,hints:SubmissionHints,selection=false):Promise<SubmissionCandidate[]> {
 const rows=(await db.query<MatchRow>(`SELECT t.id AS transaction_id,t.external_reference,t.item_title,MIN(c.provider) AS provider
  FROM transactions t LEFT JOIN proofs p ON p.transaction_id=t.id
  LEFT JOIN commerce_order_records r ON r.transaction_id=t.id
  LEFT JOIN integration_connections c ON c.id=r.connection_id
  LEFT JOIN transaction_integration_identities i ON i.transaction_id=t.id
  WHERE t.created_by=$1
   AND ($2::text IS NULL OR p.id=$2)
   AND ($3::text IS NULL OR c.provider=$3 OR split_part(i.tenant_key,':',2)=$3)
   AND ($4::text IS NULL OR r.connection_id=$4 OR c.id IN (
     SELECT current.id FROM integration_connections current JOIN integration_connections hinted
       ON current.owner_user_id=hinted.owner_user_id AND current.provider=hinted.provider AND current.external_account_reference=hinted.external_account_reference
      WHERE hinted.id=$4 AND hinted.owner_user_id=$1)
     OR i.tenant_key IN (SELECT cr.commerce_tenant_key FROM commerce_order_records cr WHERE cr.connection_id=$4))
   AND ($5::text IS NULL OR r.external_order_id=$5 OR r.external_reference=$5 OR t.external_reference=$5 OR i.external_transaction_id=$5)
   AND ($6::text IS NULL OR r.connection_id IN (SELECT id FROM integration_connections WHERE owner_user_id=$1 AND (external_account_reference=$6 OR external_account_reference=$6||'.myshopify.com')))
   AND ($7::boolean=false OR p.status IS NULL OR p.status<>'FINALIZED')
  GROUP BY t.id,t.external_reference,t.item_title ORDER BY t.id DESC LIMIT 21`,[actor,hints.proofId,hints.provider,hints.connectionId,selection?null:hints.reference,hints.storeHandle,selection])).rows;
 // A transaction may carry multiple aliases or commerce records. Keep one candidate per canonical transaction.
 return [...new Map(rows.map(row=>[row.transaction_id,row])).values()].slice(0,20).map(row=>({candidateId:newId('intake_candidate'),transactionId:row.transaction_id,orderReference:row.external_reference??'Order',itemSummary:row.item_title??'Packing order',provider:row.provider??hints.provider}));
}
async function updateOutcome(db:Database,clock:Clock,row:SubmissionRow,fields:{state:SubmissionState;nextAction:string;message:string;errorCode?:string|null;candidates?:SubmissionCandidate[];transactionId?:string|null;proofId?:string|null;resolutionHash?:string|null;clearRaw?:boolean}) {
 return (await db.query<SubmissionRow>(`UPDATE intake_submissions SET state=$3,next_action=$4,message=$5,error_code=$6,candidates=$7::jsonb,
  transaction_id=COALESCE($8,transaction_id),proof_id=COALESCE($9,proof_id),resolution_hash=COALESCE($10,resolution_hash),updated_at=$11,
  raw_text=CASE WHEN $12 THEN NULL ELSE raw_text END,lease_token=NULL,lease_expires_at=NULL,
  next_attempt_at=CASE WHEN $3='RECEIVED' THEN $11::timestamptz ELSE NULL END
  WHERE id=$1 AND actor_user_id=$2 RETURNING *`,[row.id,row.actor_user_id,fields.state,fields.nextAction,fields.message,fields.errorCode??null,JSON.stringify(fields.candidates??[]),fields.transactionId??null,fields.proofId??null,fields.resolutionHash??null,clock.now().toISOString(),fields.clearRaw??fields.state==='READY'])).rows[0];
}
async function bindCanonical(db:Database,clock:Clock,row:SubmissionRow,transactionId:string,resolutionHash?:string) {
 const exists=(await db.query<{id:string}>('SELECT id FROM transactions WHERE id=$1 AND created_by=$2',[transactionId,row.actor_user_id])).rows[0];
 if(!exists)throw new DomainError('INTAKE_CANDIDATE_NOT_FOUND','Choose an order from your own packing queue.',404);
 const prepared=await prepareExistingIntakeOrder(db,clock,row.actor_user_id,transactionId);
 const ready=prepared.readiness==='READY',archived=prepared.readiness==='ARCHIVED';
 const canonical=prepared.proofId?await resolvePackingStationTarget(db,row.actor_user_id,{reference:transactionId}):null;
 const result=await updateOutcome(db,clock,row,{state:ready||archived?'READY':'NEEDS_SELECTION',nextAction:archived?'OPEN_PROOF':ready?(canonical?.captureReady?'RECORD_PACKING':'OPEN_PROOF'):'REVIEW_DETAILS',message:archived?'This Proof is already complete.':ready?'Added to your packing queue.':'Check the order details before recording.',transactionId,proofId:prepared.proofId,resolutionHash,errorCode:prepared.reasons[0]??null,clearRaw:true});
 if(prepared.proofId)await appendAudit(db,{proofId:prepared.proofId,actorUserId:row.actor_user_id,eventType:'INTAKE_SUBMISSION_RESOLVED',eventData:{submissionId:row.id},at:clock.now()});
 return result;
}
/** Claim + fence: a retry can safely repeat canonical import after a process dies before receipt update. */
async function processSubmission(db:Database,clock:Clock,actor:string,id:string,commerce?:CommerceSyncDependencies,allowProvider=false) {
 const lease=newId('intake_lease'),now=clock.now();
 const row=await db.transaction(async tx=>{
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
  const stored=await ownedRow(tx,actor,id,undefined,true);
  if(!['RECEIVED','RESOLVING','RETRYABLE_FAILED','NEEDS_CONNECTION'].includes(stored.state))return null;
  if(stored.lease_expires_at&&new Date(stored.lease_expires_at)>now)return null;
  return (await tx.query<SubmissionRow>("UPDATE intake_submissions SET state='RESOLVING',lease_token=$2,lease_expires_at=$3,attempt_count=attempt_count+1,updated_at=$4 WHERE id=$1 RETURNING *",[id,lease,new Date(now.getTime()+120000).toISOString(),now.toISOString()])).rows[0];
 });
 if(!row)return;
 try{
  await validateHintConnection(db,actor,row.hints);
  const hasExact=!!(row.hints.proofId||row.hints.reference)&&!row.hints.listing;
  let candidates=hasExact?await findCandidates(db,actor,row.hints):[];
  const connections=(await db.query<{id:string;external_account_reference:string}>(`SELECT id,external_account_reference FROM integration_connections WHERE owner_user_id=$1 AND status='ACTIVE'
   AND ($2::text IS NULL OR provider=$2) AND ($3::text IS NULL OR id=$3 OR external_account_reference=(SELECT external_account_reference FROM integration_connections WHERE id=$3 AND owner_user_id=$1))
   AND ($4::text IS NULL OR external_account_reference=$4 OR external_account_reference=$4||'.myshopify.com') ORDER BY id LIMIT 3`,[actor,row.hints.provider,row.hints.connectionId,row.hints.storeHandle])).rows;
  let importedId:string|null=null;
  if(hasExact&&!row.hints.proofId&&candidates.length===0&&row.hints.provider&&connections.length===1&&allowProvider&&commerce){
   // Loaded lazily so the same receipt service can resolve existing local orders without a provider dependency.
   const {fetchAndImportCommerceOrder}=await import('../domain/commerce-fulfillment-sync.js');
   const imported=await fetchAndImportCommerceOrder(db,clock,actor,connections[0].id,row.hints.reference!,commerce,async tx=>{
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
    const active=await ownedRow(tx,actor,id,undefined,true);
    if(active.state!=='RESOLVING'||active.lease_token!==lease||!active.lease_expires_at||new Date(active.lease_expires_at)<=clock.now())throw new DomainError('INTAKE_LEASE_EXPIRED','This saved input is no longer waiting for that request.',409);
    const destination=(await tx.query(`SELECT id FROM integration_connections WHERE id=$1 AND owner_user_id=$2 AND status='ACTIVE' AND external_account_reference=$3 FOR UPDATE`,[connections[0].id,actor,connections[0].external_account_reference])).rows[0];
    if(!destination||active.hints.accountReference&&active.hints.accountReference!==connections[0].external_account_reference)throw new DomainError('INTAKE_CONNECTION_NOT_FOUND','Choose the connected account that owns this order.',404);
   },async(tx,imported)=>{
    if(imported.transactionId){
     const active=await ownedRow(tx,actor,id,undefined,true);
     // Canonical identity, receipt mapping and queue audit commit together, under the same intake lease.
     await bindCanonical(tx,clock,active,imported.transactionId);
    }
   });
   importedId=imported.transactionId;
  }
  if(!hasExact)candidates=await findCandidates(db,actor,row.hints,true);
  await db.transaction(async tx=>{
   await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
   const current=await ownedRow(tx,actor,id,undefined,true);
   if(current.lease_token!==lease||!current.lease_expires_at||new Date(current.lease_expires_at)<=clock.now())return;
   if(hasExact&&(candidates.length===1||importedId)){await bindCanonical(tx,clock,current,importedId??candidates[0].transactionId);return;}
   if(hasExact&&candidates.length>1){await updateOutcome(tx,clock,current,{state:'NEEDS_SELECTION',nextAction:'SELECT_ORDER',message:'More than one order matches. Choose the order you are packing.',candidates});return;}
   if(row.hints.proofId){await updateOutcome(tx,clock,current,{state:'INVALID',nextAction:'REVIEW_DETAILS',message:'This Proof is not available in your packing queue.',errorCode:'INTAKE_ORDER_NOT_FOUND',clearRaw:true});return;}
   if(row.hints.provider&&connections.length===0){await updateOutcome(tx,clock,current,{state:'NEEDS_CONNECTION',nextAction:'CONNECT_ACCOUNT',message:`Connect ${row.hints.provider==='ebay'?'eBay':row.hints.provider==='shopify'?'Shopify':'Etsy'} to find this order, or enter the order details yourself.`,errorCode:'CONNECTION_REQUIRED'});return;}
   if(hasExact&&row.hints.provider&&connections.length===1&&!allowProvider){await updateOutcome(tx,clock,current,{state:'RECEIVED',nextAction:'RETRY',message:'Order saved. Checking your connected account.'});return;}
   await updateOutcome(tx,clock,current,{state:'NEEDS_SELECTION',nextAction:candidates.length?'SELECT_ORDER':'REVIEW_DETAILS',message:row.hints.listing?'This is an item listing, not an order. Choose the matching order.':'We saved what was shared. Check the order before recording.',candidates,errorCode:hasExact&&!candidates.length?'ORDER_NOT_FOUND':null});
  });
 }catch(error){
  await db.transaction(async tx=>{
   const current=await ownedRow(tx,actor,id,undefined,true);if(current.lease_token!==lease||!current.lease_expires_at||new Date(current.lease_expires_at)<=clock.now())return;
   const reconnect=error instanceof DomainError&&['INTEGRATION_NEEDS_REAUTH','INTEGRATION_DISABLED','INTAKE_CONNECTION_NOT_FOUND','CONNECTED_ACCOUNT_REAUTH_REQUIRED','PROVIDER_AUTH_FAILED'].includes(error.code);
   const retryable=error instanceof IntegrationError?error.retryable:!(error instanceof DomainError)||error.httpStatus>=500||error.httpStatus===429;
   const rateDeferral=error instanceof DomainError&&error.httpStatus===429;
   const attempt=rateDeferral?Math.max(0,current.attempt_count-1):current.attempt_count;
   const exhausted=retryable&&attempt>=6;
   await updateOutcome(tx,clock,current,{state:reconnect?'NEEDS_CONNECTION':retryable&&!exhausted?'RETRYABLE_FAILED':'NEEDS_SELECTION',nextAction:reconnect?'CONNECT_ACCOUNT':retryable&&!exhausted?'RETRY':'REVIEW_DETAILS',message:reconnect?'Reconnect the account to finish adding this order.':exhausted?'This order could not be prepared automatically. Open PackProof to review it.':'Order saved. Open PackProof to finish adding it.',errorCode:exhausted?'INTAKE_RETRY_EXHAUSTED':error instanceof DomainError?error.code:'INTAKE_TEMPORARILY_UNAVAILABLE'});
   if(retryable&&!exhausted){
    const providerDelay=error&&typeof error==='object'&&'retryAfterSeconds' in error?Number(error.retryAfterSeconds):0;
    const delay=Math.max(Math.min(3600000,30000*2**attempt),Number.isFinite(providerDelay)&&providerDelay>0?Math.min(86400,providerDelay)*1000:0);
    await tx.query('UPDATE intake_submissions SET next_attempt_at=$2,attempt_count=$3 WHERE id=$1',[id,new Date(clock.now().getTime()+delay).toISOString(),attempt]);
   }
  });
 }
}
export async function resolveIntakeSubmission(db:Database,clock:Clock,actor:string,id:string,input:unknown,config:IntakeRuntimeConfig|undefined) {
 const body=strictRecord(input,['candidateId','confirmed','details']);
 if(body.candidateId!==undefined&&(typeof body.candidateId!=='string'||body.confirmed!==undefined||body.details!==undefined))throw new DomainError('INVALID_INTAKE_RESOLUTION','Choose one order or confirm order details.',400);
 const retry=Object.keys(body).length===0;
 const hash=sha256Hex(canonicalize(body));
 if(!retry&&body.candidateId===undefined&&(body.confirmed!==true||!body.details))throw new DomainError('INVALID_INTAKE_RESOLUTION','Confirm the order details before creating a Proof.',400);
 const result=await db.transaction(async tx=>{
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
  const row=await ownedRow(tx,actor,id,undefined,true);
  // Correcting an admitted order through the existing review screen can refresh this receipt without rebinding it.
  if(retry&&row.transaction_id&&row.state!=='DISMISSED')return bindCanonical(tx,clock,row,row.transaction_id,row.resolution_hash??undefined);
  if(row.resolution_hash){if(row.resolution_hash!==hash)throw new DomainError('IDEMPOTENCY_CONFLICT','This saved input is already attached to another resolution.',409);return row;}
  if(row.state==='DISMISSED')throw new DomainError('INTAKE_DISMISSED','This saved input was dismissed.',409);
  if(row.state==='READY'){if(retry)return row;throw new DomainError('INTAKE_ALREADY_RESOLVED','This saved input is already attached to its order.',409);}
  if(!intakeEnabled(config,actor))throw new DomainError('INTAKE_PAUSED','New order intake is paused. Your saved order remains available.',409);
  if(retry){await tx.query('UPDATE intake_submissions SET attempt_count=0 WHERE id=$1',[id]);return updateOutcome(tx,clock,row,{state:'RECEIVED',nextAction:'RETRY',message:'Order saved. Checking again.'});}
  if(body.candidateId){
   const candidate=row.candidates.find(item=>item.candidateId===body.candidateId);
   if(!candidate)throw new DomainError('INTAKE_CANDIDATE_NOT_FOUND','Choose one of the orders shown for this saved input.',404);
   return bindCanonical(tx,clock,row,candidate.transactionId,hash);
  }
  const details=strictRecord(body.details,['itemTitle','quantity','externalReference','currency','transactionValue','physicalFulfillment','paid','fulfillmentScope']);
  if(typeof details.itemTitle!=='string'||!details.itemTitle.trim()||details.itemTitle.length>200||details.quantity!==undefined&&(!Number.isSafeInteger(details.quantity)||Number(details.quantity)<1||Number(details.quantity)>100000))throw new DomainError('INVALID_INTAKE_RESOLUTION','Add an item description and a valid quantity.',400);
  if(details.externalReference!==undefined&&(typeof details.externalReference!=='string'||details.externalReference.length>200))throw new DomainError('INVALID_INTAKE_RESOLUTION','Order reference is invalid.',400);
  for(const key of ['physicalFulfillment','paid'])if(details[key]!==undefined&&typeof details[key]!=='boolean')throw new DomainError('INVALID_INTAKE_RESOLUTION','Confirm the order payment and fulfillment details.',400);
  if(details.fulfillmentScope!==undefined&&!['FULL_ORDER','PARTIAL','MULTI_PARCEL','UNKNOWN'].includes(String(details.fulfillmentScope)))throw new DomainError('INVALID_INTAKE_RESOLUTION','Choose the order fulfillment scope.',400);
  if(row.transaction_id)throw new DomainError('INTAKE_ALREADY_BOUND','Review this order through its existing Proof.',409);
  // Participant-supplied manual identity stays separate; connecting a marketplace never silently merges it.
  const {physicalFulfillment,paid,fulfillmentScope,...transactionDetails}=details;
  if(details.externalReference){
   const existing=await findCandidates(tx,actor,{...row.hints,proofId:null,provider:null,connectionId:null,storeHandle:null,reference:String(details.externalReference),listing:false});
   if(existing.length)return updateOutcome(tx,clock,row,{state:'NEEDS_SELECTION',nextAction:'SELECT_ORDER',message:'This order reference is already in your packing queue. Choose the matching order.',candidates:existing});
  }
  const transaction=await createTransaction(tx,clock,actor,{...transactionDetails,quantity:details.quantity??1,metadata:{intake:{submissionId:row.id,confirmed:true,source:row.surface==='EXPLICIT_PASTE'?'paste':'share'},intakeDeclaration:{physicalFulfillment:physicalFulfillment??null,paid:paid??null,fulfillmentScope:fulfillmentScope??'UNKNOWN'}}});
  await createOrGetProof(tx,clock,actor,transaction.transactionId);
  return bindCanonical(tx,clock,row,transaction.transactionId,hash);
 });
 if(retry&&result.state==='RECEIVED')await processSubmission(db,clock,actor,id,undefined,false);
 return getIntakeSubmission(db,actor,id);
}
export async function dismissIntakeSubmission(db:Database,clock:Clock,actor:string,id:string) {
 return db.transaction(async tx=>{
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
  const row=await ownedRow(tx,actor,id,undefined,true);
  if(row.state==='READY')throw new DomainError('INTAKE_ALREADY_RESOLVED','This input is already attached to its order.',409);
  return submissionView(await updateOutcome(tx,clock,row,{state:'DISMISSED',nextAction:'NONE',message:'Saved input dismissed.',clearRaw:true}));
 });
}
export async function reconcileIntakeSubmissions(db:Database,clock:Clock,commerce:CommerceSyncDependencies,config:IntakeRuntimeConfig|undefined) {
 const now=clock.now().toISOString();
 // Only transient operational content is removed; receipts and canonical evidence remain untouched.
 const cleaned=await db.query('UPDATE intake_submissions SET raw_text=NULL WHERE raw_text IS NOT NULL AND raw_expires_at<=$1',[now]);
 // The last permitted attempt can die too. Do not strand an expired sixth lease in RESOLVING forever.
 await db.query(`UPDATE intake_submissions SET state='NEEDS_SELECTION',next_action='REVIEW_DETAILS',error_code='INTAKE_RETRY_EXHAUSTED',
  message='This order could not be prepared automatically. Open PackProof to review it.',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=$1
  WHERE state='RESOLVING' AND attempt_count>=6 AND lease_expires_at<=$1`,[now]);
 if(!config?.enabled||!config.actorIds.length)return {processed:0,cleaned:cleaned.rowCount};
 const rows=(await db.query<{id:string;actor_user_id:string}>(`SELECT id,actor_user_id FROM intake_submissions WHERE actor_user_id=ANY($1::text[]) AND
  ((state IN ('RECEIVED','RETRYABLE_FAILED') AND (next_attempt_at IS NULL OR next_attempt_at<=$2)) OR (state='RESOLVING' AND lease_expires_at<=$2)
   OR (state='NEEDS_CONNECTION' AND EXISTS(SELECT 1 FROM integration_connections c WHERE c.owner_user_id=intake_submissions.actor_user_id AND c.status='ACTIVE' AND c.provider=intake_submissions.hints->>'provider')))
  AND attempt_count<6 AND actor_user_id IN (SELECT id FROM users WHERE status='ACTIVE') ORDER BY updated_at,id LIMIT 10`,[config.actorIds,now])).rows;
 for(const row of rows)await processSubmission(db,clock,row.actor_user_id,row.id,commerce,true);
 return {processed:rows.length,cleaned:cleaned.rowCount};
}
