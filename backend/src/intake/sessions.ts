import {randomBytes} from 'node:crypto';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {newId} from '../ids.js';
import {sha256Hex} from '../hash.js';
import {DomainError} from '../domain/errors.js';
import {requireActiveAccount} from '../domain/account-access.js';

export const INTAKE_SESSION_PREFIX='pp_intake_';
export async function createIntakeSession(db:Database,clock:Clock,actorId:string) {
 await requireActiveAccount(db,actorId);
 const sessionId=newId('intake_session'),token=INTAKE_SESSION_PREFIX+randomBytes(32).toString('base64url');
 const now=clock.now(),expiresAt=new Date(now.getTime()+12*60*60*1000).toISOString();
 await db.query('INSERT INTO intake_scoped_sessions(id,actor_user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',[sessionId,actorId,sha256Hex(token),now.toISOString(),expiresAt]);
 return {sessionId,token,actorId,expiresAt};
}
export async function authenticateIntakeSession(db:Database,clock:Clock,token:string) {
 if(!/^pp_intake_[A-Za-z0-9_-]{43}$/.test(token))throw new DomainError('INTAKE_SESSION_EXPIRED','Open PackProof and sign in to finish adding this order.',401);
 const row=(await db.query<{id:string;actor_user_id:string}>('SELECT id,actor_user_id FROM intake_scoped_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>$2',[sha256Hex(token),clock.now().toISOString()])).rows[0];
 if(!row)throw new DomainError('INTAKE_SESSION_EXPIRED','Open PackProof and sign in to finish adding this order.',401);
 await requireActiveAccount(db,row.actor_user_id);
 return {sessionId:row.id,actorId:row.actor_user_id};
}
export async function revokeIntakeSession(db:Database,clock:Clock,actorId:string,sessionId:string) {
 const row=(await db.query('UPDATE intake_scoped_sessions SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND actor_user_id=$2 RETURNING id',[sessionId,actorId,clock.now().toISOString()])).rows[0];
 if(!row)throw new DomainError('INTAKE_SESSION_NOT_FOUND','This intake session is not available.',404);
 return {revoked:true};
}
