import type { Database } from '../db/database.js';
import { DomainError } from './errors.js';

export const ONBOARDING_VERSION = 1;
type FirstProof={id:string;status:string;created_at:string|Date;updated_at:string|Date;recorded_at:string|Date|null};
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
// Milestones come from committed domain records, never client assertions.
export async function getOnboarding(db:Database,user:string) {
  return db.transaction(async tx=>{
    const state=await read(tx,user);
    let firstProof:FirstProof|null=null;
    if(state.onboarding_enrolled){
      firstProof=(await tx.query<FirstProof>(`SELECT p.id,p.status,p.created_at,p.updated_at,
        (SELECT MIN(e.committed_at) FROM evidence e WHERE e.proof_id=p.id AND e.committed_at IS NOT NULL AND e.content_type LIKE 'video/%') AS recorded_at
        FROM proofs p JOIN transactions t ON t.id=p.transaction_id WHERE t.created_by=$1 ORDER BY p.created_at,p.id LIMIT 1`,[user])).rows[0]??null;
      if(firstProof){
        await event(tx,user,'first_proof_started',-1,firstProof.created_at);
        if(firstProof.recorded_at)await event(tx,user,'first_proof_recorded',-1,firstProof.recorded_at);
        if(firstProof.status==='FINALIZED'){
          await event(tx,user,'first_proof_completed',-1,firstProof.updated_at);
          if(!state.onboarding_completed)await event(tx,user,'onboarding_completed');
          await tx.query('UPDATE users SET onboarding_completed=TRUE,onboarding_version=GREATEST(onboarding_version,$2),onboarding_last_step=NULL WHERE id=$1',[user,ONBOARDING_VERSION]);
        }
      }
    }
    return {...await read(tx,user),current_version:ONBOARDING_VERSION,first_proof_id:firstProof?.id??null,first_proof_completed:firstProof?.status==='FINALIZED'};
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
