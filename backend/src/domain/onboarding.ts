import type { Database } from '../db/database.js';
import { DomainError } from './errors.js';
import { asRequiredIso } from './types.js';

export const ONBOARDING_VERSION = 1;
export const FIRST_EXPERIENCE_VERSION = 1;
type FirstProof={id:string;status:string;created_at:string|Date;finalized_at:string|Date|null;recorded_at:string|Date|null};
type State = { onboarding_completed:boolean; onboarding_version:number; first_proof_coaching_completed:boolean; onboarding_last_step:number|null; onboarding_enrolled:boolean };
const fields='onboarding_completed,onboarding_version,first_proof_coaching_completed,onboarding_last_step,onboarding_enrolled';
async function event(db:Database,user:string,name:string,step=-1,at?:string|Date) {
  await db.query('INSERT INTO onboarding_events(user_id,version,event,step,occurred_at) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now())) ON CONFLICT DO NOTHING',[user,ONBOARDING_VERSION,name,step,at??null]);
}
async function read(db:Database,user:string) {
  if(!(await db.query("SELECT id FROM schema_migrations WHERE id='075_onboarding'")).rows.length)throw new DomainError('ONBOARDING_NOT_READY','Tutorial account sync is being enabled. Try again shortly.',503);
  const row=(await db.query<State>(`SELECT ${fields} FROM users WHERE id=$1`,[user])).rows[0];
  if(!row)throw new DomainError('USER_NOT_FOUND','User not found',404);
  return row;
}
// A receiving/viewing participant, a synthetic provider fixture, and an API
// sandbox record are not a seller's first production packing Proof. The public
// sample is local/read-only and creates none of these domain records.
export const ELIGIBLE_PACKING_PROOFS_SQL = `SELECT p.id,p.status,p.created_at,p.finalized_at,p.manifest_id,seller.user_id AS seller_user_id,
  (SELECT MIN(e.committed_at) FROM evidence e
   WHERE e.proof_id=p.id AND e.submitted_by=seller.user_id AND e.validation_status='COMMITTED'
     AND e.committed_at IS NOT NULL AND e.content_type LIKE 'video/%'
     AND e.evidence_type='FULFILLMENT_CAPTURE'
     AND e.capture_origin IN ('LEGACY_UNKNOWN','AUTHORIZED_CAPTURE_SESSION','CLIENT_REPORTED_DESKTOP_CAPTURE')) AS recorded_at
  FROM proofs p JOIN transactions t ON t.id=p.transaction_id
  JOIN proof_participants seller ON seller.proof_id=p.id AND seller.role='SELLER'
  WHERE t.created_by=seller.user_id AND p.workflow_type='COMMERCE_SALE'
    AND NOT EXISTS (SELECT 1 FROM api_tenant_proofs ap JOIN api_tenants tenant ON tenant.id=ap.tenant_id
                    WHERE ap.proof_id=p.id AND tenant.environment='sandbox')
    AND NOT EXISTS (SELECT 1 FROM transaction_integration_identities i WHERE i.transaction_id=t.id
      AND (i.adapter_key IN ('demo-storefront','demo-marketplace') OR i.tenant_key ~* '(^|[:.])sandbox([:.]|$)'))
    AND COALESCE(t.transaction_metadata->>'sample','false') <> 'true'
    AND COALESCE(t.transaction_metadata->>'environment','live') NOT IN ('sandbox','test','sample')
    AND COALESCE(t.transaction_metadata#>>'{import,providerIdentifiers,environment}','live') IN ('live','production')
    AND COALESCE(t.transaction_metadata#>>'{import,adapterKey}','') NOT IN ('demo-storefront','demo-marketplace')`;
export const ELIGIBLE_FINALIZED_PACKING_PROOFS_SQL = `SELECT p.* FROM (${ELIGIBLE_PACKING_PROOFS_SQL}) p
  JOIN final_manifests m ON m.id=p.manifest_id AND m.proof_id=p.id
  WHERE p.status='FINALIZED' AND p.finalized_at IS NOT NULL AND p.recorded_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM attestations a WHERE a.proof_id=p.id AND a.attested_by=p.seller_user_id AND a.statement='PACKED_DESCRIBED_ITEM')`;

// Milestones come from committed domain records, never client assertions. Each
// milestone is independently selected: an abandoned first draft cannot hide a
// later finalized Proof. Tutorial preferences are not an activation signal.
export async function getOnboarding(db:Database,user:string) {
  return db.transaction(async tx=>{
    const state=await read(tx,user);
    const firstProof=(await tx.query<FirstProof>(`SELECT * FROM (${ELIGIBLE_PACKING_PROOFS_SQL}) p
      WHERE seller_user_id=$1 ORDER BY created_at,id LIMIT 1`,[user])).rows[0]??null;
    const firstRecorded=(await tx.query<FirstProof>(`SELECT * FROM (${ELIGIBLE_PACKING_PROOFS_SQL}) p
      WHERE seller_user_id=$1 AND recorded_at IS NOT NULL ORDER BY recorded_at,id LIMIT 1`,[user])).rows[0]??null;
    const firstFinalized=(await tx.query<FirstProof>(`SELECT * FROM (${ELIGIBLE_FINALIZED_PACKING_PROOFS_SQL}) p
      WHERE seller_user_id=$1 ORDER BY finalized_at,id LIMIT 1`,[user])).rows[0]??null;
    if(state.onboarding_enrolled){
      if(firstProof)await event(tx,user,'first_proof_started',-1,firstProof.created_at);
      if(firstRecorded?.recorded_at)await event(tx,user,'first_proof_recorded',-1,firstRecorded.recorded_at);
      if(firstFinalized?.finalized_at)await event(tx,user,'first_proof_completed',-1,firstFinalized.finalized_at);
    }
    // Separate event identity avoids treating historical tutorial completion or
    // the older first-created-Proof metric as first packing activation.
    if(firstFinalized?.finalized_at)await event(tx,user,'first_packing_proof_finalized',-1,firstFinalized.finalized_at);
    return {...state,current_version:ONBOARDING_VERSION,first_proof_id:firstFinalized?.id??firstProof?.id??null,
      first_proof_completed:!!firstFinalized,first_experience_version:FIRST_EXPERIENCE_VERSION,automatic_tour:false,
      activation_status:firstFinalized?'ACTIVATED' as const:'NOT_ACTIVATED' as const,
      first_finalized_packing_proof_id:firstFinalized?.id??null,
      first_finalized_packing_at:firstFinalized?.finalized_at?asRequiredIso(firstFinalized.finalized_at):null};
  });
}
export async function updateOnboarding(db:Database,user:string,input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DomainError('INVALID_ONBOARDING','Invalid tutorial action',400);
  const {action,step,version}=input as Record<string,unknown>;
  if(version!==ONBOARDING_VERSION||!['start','step','skip','complete','dismiss_coaching'].includes(String(action)))throw new DomainError('INVALID_ONBOARDING','Unsupported tutorial action or version',400);
  if((action==='step'||action==='skip')&&(!Number.isInteger(step)||Number(step)<0||Number(step)>5))throw new DomainError('INVALID_ONBOARDING','Invalid tutorial step',400);
  await db.transaction(async tx=>{
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user]);
    const state=await read(tx,user);
    if(action==='dismiss_coaching')await tx.query('UPDATE users SET first_proof_coaching_completed=TRUE WHERE id=$1',[user]);
    // Replay never calls these writes; stale devices cannot reopen completed guidance.
    else if(state.onboarding_enrolled&&!state.onboarding_completed){
      if(action==='start')await event(tx,user,'onboarding_started');
      if(action==='step'){
        await event(tx,user,'onboarding_started');
        await event(tx,user,'onboarding_step_viewed',Number(step));
        await tx.query('UPDATE users SET onboarding_last_step=$2 WHERE id=$1',[user,step]);
      }
      if(action==='skip'||action==='complete'){
        await event(tx,user,action==='skip'?'onboarding_skipped':'onboarding_completed',action==='skip'?Number(step):-1);
        await tx.query('UPDATE users SET onboarding_completed=TRUE,onboarding_version=$2,onboarding_last_step=NULL,first_proof_coaching_completed=first_proof_coaching_completed OR $3 WHERE id=$1',[user,ONBOARDING_VERSION,action==='skip']);
      }
    }
  });
  return getOnboarding(db,user);
}
