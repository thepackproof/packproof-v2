import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import type {OfferDefinition} from './usage-ledger.js';

/** Call inside the authorized seller capture transaction. The user row serializes
 * concurrent admission. A reservation survives retries and never affects old access.
 * Free accounts without any enrolled period retain the ordinary pilot workflow. */
export async function reserveApprovedCaptureAllowance(tx:Database,clock:Clock,input:{userId:string;proofId:string;declaredBytes?:number;declaredSeconds?:number}):Promise<{enforced:false}|{enforced:true;maxRecordingBytes:number;maxRecordingSeconds:number}> {
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[input.userId]);
  const own=(await tx.query("SELECT 1 FROM proof_participants WHERE proof_id=$1 AND user_id=$2 AND role='SELLER'",[input.proofId,input.userId])).rows[0];
  if(!own)throw new DomainError('BILLING_CAPTURE_SELLER_REQUIRED','Only the seller can reserve a new capture allowance',403);
  const existing=(await tx.query<{definition_json:OfferDefinition;user_id:string}>(`SELECT o.definition_json,r.user_id FROM billing_capture_reservations r
    JOIN billing_account_offer_periods p ON p.id=r.offer_period_id JOIN billing_offer_versions o ON o.version=p.offer_version WHERE r.proof_id=$1`,[input.proofId])).rows[0];
  const limits=(offer:OfferDefinition)=>{
    if(input.declaredBytes!==undefined&&(!Number.isSafeInteger(input.declaredBytes)||input.declaredBytes<1||input.declaredBytes>offer.maxRecordingBytes)
      ||input.declaredSeconds!==undefined&&(!Number.isFinite(input.declaredSeconds)||input.declaredSeconds<=0||input.declaredSeconds>offer.maxRecordingSeconds))
      throw new DomainError('BILLING_RECORDING_LIMIT','This recording exceeds the limits of the accepted offer',422);
    return {enforced:true as const,maxRecordingBytes:offer.maxRecordingBytes,maxRecordingSeconds:offer.maxRecordingSeconds};
  };
  if(existing){if(existing.user_id!==input.userId)throw new DomainError('BILLING_CAPTURE_OWNER_MISMATCH','Capture reservation belongs to another seller',403);return limits(existing.definition_json);}
  const period=(await tx.query<{id:string;definition_json:OfferDefinition}>(`SELECT p.id,o.definition_json FROM billing_account_offer_periods p
    JOIN billing_offer_versions o ON o.version=p.offer_version WHERE p.user_id=$1 AND p.period_start<=$2 AND p.period_end>$2`,[input.userId,clock.now().toISOString()])).rows[0];
  if(!period){
    if((await tx.query('SELECT 1 FROM billing_account_offer_periods WHERE user_id=$1 AND period_start<=$2 LIMIT 1',[input.userId,clock.now().toISOString()])).rows.length)
      throw new DomainError('BILLING_OFFER_RENEWAL_REQUIRED','Your plan needs renewal before starting another Proof. Saved Proofs and capture recovery remain available.',402);
    return {enforced:false};
  }
  const bounded=limits(period.definition_json);
  // UNION counts a reserved Proof once when delayed metering subsequently records it.
  // Also count canonical finalized records immediately, before the usage worker runs.
  const count=(await tx.query<{used:string|number}>(`SELECT COUNT(*) AS used FROM (
    SELECT proof_id FROM billing_capture_reservations WHERE offer_period_id=$1
    UNION SELECT proof_id FROM billing_proof_usage WHERE offer_period_id=$1
    UNION SELECT p.id FROM proofs p JOIN proof_participants pp ON pp.proof_id=p.id AND pp.role='SELLER'
      JOIN billing_account_offer_periods op ON op.id=$1 WHERE pp.user_id=$2 AND p.status='FINALIZED'
      AND p.finalized_at>=op.period_start AND p.finalized_at<op.period_end
  ) used`,[period.id,input.userId])).rows[0];
  if(Number(count.used)>=period.definition_json.includedFinalizedProofs)
    throw new DomainError('BILLING_CAPTURE_ALLOWANCE_EXHAUSTED','Your plan allowance is in use. You can finish existing captures and access saved Proofs.',402);
  await tx.query('INSERT INTO billing_capture_reservations(proof_id,user_id,offer_period_id,reserved_at) VALUES($1,$2,$3,$4)',[input.proofId,input.userId,period.id,clock.now().toISOString()]);
  return bounded;
}
