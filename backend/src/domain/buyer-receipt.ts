import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { DomainError } from './errors.js';
import { appendAudit } from './audit.js';
export async function requireReceiptBuyer(db:Database,userId:string,proofId:string) {
  const found=await db.query('SELECT user_id FROM proof_participants WHERE proof_id=$1 AND user_id=$2 AND role=\'BUYER\' UNION ALL SELECT user_id FROM commerce_receivers WHERE proof_id=$1 AND user_id=$2',[proofId,userId]);
  if(!found.rows[0]) throw new DomainError('PARTICIPANT_NOT_AUTHORIZED','Use the buyer account invited to this Proof',403);
}
export async function setReceiptPreference(db:Database,clock:Clock,userId:string,proofId:string,optedIn:unknown) {
  if(typeof optedIn!=='boolean') throw new DomainError('INVALID_PREFERENCE','Choose whether to receive receipt updates',400);
  await requireReceiptBuyer(db,userId,proofId);
  const verified=await db.query('SELECT 1 FROM user_verified_contacts WHERE user_id=$1',[userId]);
  if(optedIn&&!verified.rows[0]) throw new DomainError('RECEIPT_CONTACT_UNVERIFIED','Verify your email before opting in to receipt notifications',409);
  return db.transaction(async tx=>{
    await tx.query('INSERT INTO proof_receipt_preferences(proof_id,user_id,opted_in,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(proof_id,user_id) DO UPDATE SET opted_in=EXCLUDED.opted_in,updated_at=EXCLUDED.updated_at',[proofId,userId,optedIn,clock.now().toISOString()]);
    if(!optedIn) await tx.query('UPDATE proof_notification_outbox SET cancelled_at=$3 WHERE proof_id=$1 AND subscription_id IN (SELECT id FROM proof_notification_subscriptions WHERE proof_id=$1 AND recipient_user_id=$2) AND sent_at IS NULL AND cancelled_at IS NULL',[proofId,userId,clock.now().toISOString()]);
    await appendAudit(tx,{proofId,actorUserId:userId,eventType:'BUYER_RECEIPT_NOTIFICATION_PREFERENCE',eventData:{optedIn},at:clock.now()});
    return {optedIn,message:'Notification preferences do not affect the seller Proof or indicate acceptance.'};
  });
}
export async function verifiedReceiptContact(db:Database,proofId:string,email:string):Promise<string> {
  const rows=await db.query<{user_id:string}>(`SELECT c.user_id FROM user_verified_contacts c
    JOIN proof_receipt_preferences p ON p.user_id=c.user_id AND p.proof_id=$1 AND p.opted_in=TRUE
    WHERE c.email_normalized=$2 AND (EXISTS(SELECT 1 FROM proof_participants pp WHERE pp.proof_id=$1 AND pp.user_id=c.user_id AND pp.role='BUYER') OR EXISTS(SELECT 1 FROM commerce_receivers cr WHERE cr.proof_id=$1 AND cr.user_id=c.user_id))`,[proofId,email.toLowerCase()]);
  if(rows.rows.length!==1) throw new DomainError('RECEIPT_CONTACT_UNVERIFIED','The invited buyer must verify this email and opt in before receiving notifications',409);
  return rows.rows[0].user_id;
}
