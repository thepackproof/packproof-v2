import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { requireRecordAccess,type RecordWorkspace } from './access.js';

// An unforgeable process-local read capability. It is never stored as a
// participant, accepted from a request or attached to a pooled SQL connection.
const grants=new WeakMap<Database,{workspace:RecordWorkspace;proofId:string;check:()=>Promise<void>}>();
export function withRecordReadGrant(db:Database,workspace:RecordWorkspace,proofId:string):Database {
  if(workspace.partner)throw new DomainError('HUMAN_AUTHENTICATION_REQUIRED','The records media gateway requires a human session',403);
  const wrapped:Database={query:(sql,params)=>db.query(sql,params),transaction:fn=>db.transaction(tx=>fn(withRecordReadGrant(tx,workspace,proofId)))};
  grants.set(wrapped,{workspace,proofId,check:async()=>{await requireRecordAccess(db,workspace,proofId);}});
  return wrapped;
}
export async function recordReadAuthorization(db:Database,userId:string,proofId:string) {
  const grant=grants.get(db);if(!grant)return null;
  if(grant.workspace.userId!==userId||grant.proofId!==proofId)throw new DomainError('PROOF_NOT_FOUND','Record not found',404);
  await grant.check();
  return {id:`organization-read:${grant.workspace.membershipId}`,proof_id:proofId,user_id:userId,role:'SELLER' as const,joined_at:new Date(0)};
}
