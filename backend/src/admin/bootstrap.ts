import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { appendAdminAudit } from './audit.js';

/** Explicit operator bootstrap only. Email is corroborating evidence for the
 * one initial assignment, never the authorization key at request time. */
export async function bootstrapSystemAdmin(db:Database,clock:Clock,input:{userId:string;cognitoSubject:string;reason:string}) {
  if(!input.userId||!input.cognitoSubject||input.reason.trim().length<8)throw new DomainError('INVALID_ADMIN_BOOTSTRAP','Explicit internal user ID, Cognito subject and reason are required',400);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(1347438146,69)');
    const account=(await tx.query<{id:string;status:string}>(`SELECT u.id,u.status FROM users u
      JOIN auth_identities a ON a.user_id=u.id AND a.provider='cognito' AND a.provider_subject=$2 AND a.can_authenticate=true
      JOIN user_verified_contacts c ON c.user_id=u.id AND c.email_normalized='admin@thepackproof.com' AND c.source='COGNITO'
      WHERE u.id=$1 FOR UPDATE OF u`,[input.userId,input.cognitoSubject])).rows[0];
    if(!account||account.status!=='ACTIVE')throw new DomainError('ADMIN_BOOTSTRAP_IDENTITY_MISMATCH','The active internal account, Cognito subject and verified initial administrator contact must all match',409);
    const existing=(await tx.query<{user_id:string}>('SELECT user_id FROM user_system_roles')).rows;
    if(existing.some(row=>row.user_id===input.userId))return {userId:input.userId,role:'SYSTEM_ADMIN',alreadyAssigned:true};
    if(existing.length)throw new DomainError('ADMIN_ALREADY_BOOTSTRAPPED','An initial administrator is already assigned. Use the reviewed role recovery procedure.',409);
    await tx.query("INSERT INTO user_system_roles(user_id,role,granted_at) VALUES($1,'SYSTEM_ADMIN',$2)",[input.userId,clock.now().toISOString()]);
    await appendAdminAudit(tx,clock,{actorId:null,action:'SYSTEM_ADMIN_BOOTSTRAPPED',targetType:'user',targetId:input.userId,
      reason:input.reason,before:{role:null},after:{role:'SYSTEM_ADMIN',identityProvider:'cognito'},operationId:`bootstrap:${input.userId}`,severity:'critical'});
    return {userId:input.userId,role:'SYSTEM_ADMIN',alreadyAssigned:false};
  });
}
