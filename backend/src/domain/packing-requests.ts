import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { DomainError } from './errors.js';
import { createOrGetProof } from './create-proof.js';
import { appendAudit } from './audit.js';

type Row={id:string;buyer_user_id:string;seller_user_id:string;order_reference:string;relationship_assurance:string;state:string;proof_id:string|null;requested_at:string;expires_at:string;reminder_count:number;last_reminded_at:string|null};
const normalize=(s:string)=>s.trim().normalize('NFKC').toLowerCase();
const missing=()=>new DomainError('PACKING_REQUEST_NOT_FOUND','Packing request is unavailable',404);
function view(r:Row){return {requestId:r.id,buyerUserId:r.buyer_user_id,sellerUserId:r.seller_user_id,orderReference:r.order_reference,relationshipAssurance:r.relationship_assurance,state:r.state,proofId:r.proof_id,requestedAt:r.requested_at,expiresAt:r.expires_at,reminderCount:r.reminder_count,statusText:r.state==='CAPTURED'?'Packing recording provided':r.state==='ACCEPTED'?'Seller accepted; awaiting recording':'Packing Proof not provided',cost:'No charge is created by this request.',task:'Record the item, packing, seal and shipping label. Capture duration depends on the shipment.'};}
async function expire(db:Database,clock:Clock,actor:string){await db.query("UPDATE packing_proof_requests SET state='EXPIRED' WHERE state='REQUESTED' AND expires_at<=$1 AND (buyer_user_id=$2 OR seller_user_id=$2)",[clock.now().toISOString(),actor]);
// CAPTURED requires preservation/finalization; merely accepting never claims recording success.
await db.query("UPDATE packing_proof_requests r SET state='CAPTURED' FROM proofs p WHERE r.proof_id=p.id AND r.state='ACCEPTED' AND p.status='FINALIZED' AND EXISTS(SELECT 1 FROM recovery_delivery d WHERE d.operation_id='finalize:'||p.id AND d.state='DURABLE' AND d.receipt_json IS NOT NULL) AND (r.buyer_user_id=$1 OR r.seller_user_id=$1) AND EXISTS(SELECT 1 FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED' AND e.content_type LIKE 'video/%' AND e.evidence_type IN ('FULFILLMENT_CAPTURE','PACKING_CAPTURE'))",[actor]);}
export async function listPackingRequests(db:Database,clock:Clock,actor:string){await expire(db,clock,actor);return {requests:(await db.query<Row>('SELECT * FROM packing_proof_requests WHERE buyer_user_id=$1 OR seller_user_id=$1 ORDER BY requested_at DESC LIMIT 100',[actor])).rows.map(view)};}
export async function requestPackingProof(db:Database,clock:Clock,actor:string,input:Record<string,unknown>){
  if(typeof input.sellerUserId!=='string'||input.sellerUserId===actor||typeof input.orderReference!=='string'||!input.orderReference.trim()||input.orderReference.length>200)throw new DomainError('INVALID_PACKING_REQUEST','Choose a seller and an order reference of up to 200 characters.',400);
  if(input.verified===true||input.transactionId||input.proofId)throw new DomainError('REQUEST_RELATIONSHIP_UNVERIFIED','A user-provided reference does not establish an integration-verified order relationship.',400);
  return db.transaction(async tx=>{
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
    if(!(await tx.query('SELECT id FROM users WHERE id=$1',[input.sellerUserId])).rows[0])throw missing();
    const hash=sha256Hex(normalize(input.orderReference as string));
    const old=(await tx.query<Row>('SELECT * FROM packing_proof_requests WHERE buyer_user_id=$1 AND seller_user_id=$2 AND reference_sha256=$3',[actor,input.sellerUserId,hash])).rows[0];if(old)return view(old);
    const n=(await tx.query<{count:string}>('SELECT count(*) AS count FROM packing_proof_requests WHERE buyer_user_id=$1 AND requested_at>$2',[actor,new Date(clock.now().getTime()-86400000).toISOString()])).rows[0];
    if(Number(n.count)>=10)throw new DomainError('PACKING_REQUEST_RATE_LIMIT','You can make up to ten new packing requests per day.',429);
    const row=(await tx.query<Row>(`INSERT INTO packing_proof_requests(id,buyer_user_id,seller_user_id,order_reference,reference_sha256,relationship_assurance,state,requested_at,expires_at) VALUES($1,$2,$3,$4,$5,'USER_PROVIDED_UNVERIFIED','REQUESTED',$6,$7) RETURNING *`,[newId('ppr'),actor,input.sellerUserId,(input.orderReference as string).trim(),hash,clock.now().toISOString(),new Date(clock.now().getTime()+7*86400000).toISOString()])).rows[0];return view(row);
  });
}
export async function respondPackingRequest(db:Database,clock:Clock,actor:string,id:string,input:Record<string,unknown>){
  if(!['ACCEPT','DECLINE'].includes(String(input.action)))throw new DomainError('INVALID_PACKING_REQUEST','Choose accept or decline.',400);
  await expire(db,clock,actor);
  return db.transaction(async tx=>{
    const r=(await tx.query<Row>('SELECT * FROM packing_proof_requests WHERE id=$1 AND seller_user_id=$2 FOR UPDATE',[id,actor])).rows[0];if(!r)throw missing();
    if(r.state!=='REQUESTED'){if((input.action==='ACCEPT'&&['ACCEPTED','CAPTURED'].includes(r.state))||(input.action==='DECLINE'&&r.state==='DECLINED'))return view(r);throw new DomainError('PACKING_REQUEST_CLOSED','This packing request is already closed.',409);}
    let proofId:string|null=null;
    if(input.action==='ACCEPT'){
      if(typeof input.transactionId!=='string'||input.confirmOrderReference!==true)throw new DomainError('PACKING_REQUEST_ORDER_REQUIRED','Select your existing order and confirm that this request refers to it.',400);
      const txn=(await tx.query<{id:string;external_reference:string|null}>('SELECT id,external_reference FROM transactions WHERE id=$1 AND created_by=$2 FOR UPDATE',[input.transactionId,actor])).rows[0];if(!txn)throw missing();
      const proof=await createOrGetProof(tx,clock,actor,txn.id,{participationPolicy:'COUNTERPARTY_OPTIONAL'});proofId=proof.proofId;
      // Acceptance establishes a request relationship only. Existing scoped invitation
      // flow separately controls buyer media access and contributions.
      await appendAudit(tx,{proofId,actorUserId:actor,eventType:'PACKING_REQUEST_ACCEPTED',eventData:{requestId:id,buyerUserId:r.buyer_user_id,orderReference:r.order_reference,relationshipAssurance:'SELLER_CONFIRMED_USER_REFERENCE',accessGranted:false},at:clock.now()});
    }
    const row=(await tx.query<Row>('UPDATE packing_proof_requests SET state=$2,proof_id=$3,responded_at=$4 WHERE id=$1 RETURNING *',[id,input.action==='ACCEPT'?'ACCEPTED':'DECLINED',proofId,clock.now().toISOString()])).rows[0];return view(row);
  });
}
export async function remindPackingRequest(db:Database,clock:Clock,actor:string,id:string){await expire(db,clock,actor);return db.transaction(async tx=>{const r=(await tx.query<Row>('SELECT * FROM packing_proof_requests WHERE id=$1 AND buyer_user_id=$2 FOR UPDATE',[id,actor])).rows[0];if(!r)throw missing();if(r.state!=='REQUESTED'||r.reminder_count>=3||(r.last_reminded_at&&clock.now().getTime()-Date.parse(r.last_reminded_at)<86400000))throw new DomainError('PACKING_REMINDER_LIMIT','Reminders are limited to once per day and three per request.',429);return view((await tx.query<Row>('UPDATE packing_proof_requests SET reminder_count=reminder_count+1,last_reminded_at=$2 WHERE id=$1 RETURNING *',[id,clock.now().toISOString()])).rows[0]);});}
