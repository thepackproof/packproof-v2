import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../s3/object-store.js';
import type { ProofAccessLinkRow } from './access-links.js';
import { disclosureContextForLink, getDisclosureProjection, readDisclosedMedia, resolveDisclosureContext } from './disclosure.js';
import { DomainError } from './errors.js';
import { appendAudit } from './audit.js';
export type PublicProofView = Awaited<ReturnType<typeof getDisclosureProjection>>;
export async function getPublicProof(db: Database, clock: Clock, token: string): Promise<PublicProofView> {
  const ctx=await resolveDisclosureContext(db, clock, {token});
  const view=await getDisclosureProjection(db,ctx);
  const claim=(await db.query<{ticket_id:string;worker_reference:string;request_id:string;key_id:string}>('SELECT ticket_id,worker_reference,request_id,key_id FROM claims_viewer_sessions WHERE access_link_id=$1',[ctx.grantId])).rows[0];
  if(claim)await appendAudit(db,{proofId:ctx.proofId,actorUserId:null,eventType:'CLAIMS_PROOF_OPENED',eventData:{accessLinkId:ctx.grantId,ticketId:claim.ticket_id,workerReference:claim.worker_reference,requestId:claim.request_id,keyId:claim.key_id},at:clock.now()});
  return view;
}
export async function projectPublicProof(db: Database, link: ProofAccessLinkRow): Promise<PublicProofView> {
  return getDisclosureProjection(db, await disclosureContextForLink(db, link));
}
export const readPublicEvidence = (db:Database, clock:Clock, store:ObjectStore, token:string, evidenceId:string) => readDisclosedMedia(db,clock,store,token,evidenceId);
export function assertGuestCannotMutate(): never { throw new DomainError('PARTICIPANT_NOT_AUTHORIZED','A viewing link cannot change this Proof',403); }
