import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { requireActiveAccount } from "./account-access.js";
import { appendAccountAudit } from "./account-audit.js";
import { DomainError } from "./errors.js";
import { asRequiredIso } from "./types.js";

export const ACCOUNT_DELETION_RETENTION_NOTICE = 'Your request will be reviewed. Account information and connected-account credentials will be assessed for deletion. Proof records may be retained where required for an active dispute, retention obligation, or record integrity; we will explain what must remain. Submitting a request does not mean deletion is complete.';
type RequestRow = {id:string;state:string;requested_at:string|Date;updated_at:string|Date};
export async function getAccountDeletionRequest(db:Database, userId:string) {
  await requireActiveAccount(db,userId);
  const row=(await db.query<RequestRow>('SELECT id,state,requested_at,updated_at FROM account_deletion_requests WHERE user_id=$1',[userId])).rows[0];
  return {request:row?{requestId:row.id,state:row.state,requestedAt:asRequiredIso(row.requested_at),updatedAt:asRequiredIso(row.updated_at)}:null,retentionNotice:ACCOUNT_DELETION_RETENTION_NOTICE};
}
export async function requestAccountDeletion(db:Database, clock:Clock, userId:string, input:unknown) {
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>key!=='confirmation') || (input as {confirmation?:unknown}).confirmation!=='REQUEST_ACCOUNT_DELETION') {
    throw new DomainError('ACCOUNT_DELETION_CONFIRMATION_REQUIRED','Confirm that you want to request account deletion.',400);
  }
  return db.transaction(async tx=>{
    await requireActiveAccount(tx,userId);
    const now=clock.now();
    const result=await tx.query<{id:string}>(`INSERT INTO account_deletion_requests(id,user_id,requested_at,updated_at)
      VALUES($1,$2,$3,$3) ON CONFLICT(user_id) DO NOTHING RETURNING id`,[newId('account_deletion'),userId,now.toISOString()]);
    if(result.rows[0]) await appendAccountAudit(tx,{actorUserId:userId,eventType:'ACCOUNT_DELETION_REQUESTED',eventData:{requestId:result.rows[0].id},at:now});
    return getAccountDeletionRequest(tx,userId);
  });
}
