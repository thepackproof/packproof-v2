import type { Database } from '../db/database.js';
import type { PartnerActor } from './organizations.js';
import { authorizePartnerProof } from './organizations.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';

// Process-local, unforgeable authorization capability. It exists only for a
// server-created read/export call, never on client input or pooled connections.
const grants=new WeakMap<Database,{actor:PartnerActor;proofId:string;check:()=>Promise<void>}>();
export function withPartnerReadGrant(db:Database,clock:Clock,actor:PartnerActor,proofId:string,scope:'proofs:read'|'exports:read'):Database {
 const wrapped:Database={query:(sql,params)=>db.query(sql,params),transaction:fn=>db.transaction(tx=>fn(withPartnerReadGrant(tx,clock,actor,proofId,scope)))};
 grants.set(wrapped,{actor,proofId,check:async()=>{await authorizePartnerProof(db,clock,actor,proofId,scope);}});return wrapped;
}
export async function partnerReadAuthorization(db:Database,userId:string,proofId:string){
 const grant=grants.get(db);if(!grant)return null;
 if(grant.actor.actorUserId!==userId||grant.proofId!==proofId)throw new DomainError('PROOF_NOT_FOUND','Proof not found',404);
 await grant.check();
 // This is an authorization result, not a stored participant or human attestation.
 return {id:`delegated-read:${grant.actor.principalId}`,proof_id:proofId,user_id:userId,role:'SELLER' as const,joined_at:new Date(0)};
}
