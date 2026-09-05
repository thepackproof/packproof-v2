import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../s3/object-store.js';
import type { ProofAccessLinkRow } from './access-links.js';
import { disclosureContextForLink, getDisclosureProjection, readDisclosedMedia, resolveDisclosureContext } from './disclosure.js';
import { DomainError } from './errors.js';
export type PublicProofView = Awaited<ReturnType<typeof getDisclosureProjection>>;
export async function getPublicProof(db: Database, clock: Clock, token: string): Promise<PublicProofView> {
  return getDisclosureProjection(db, await resolveDisclosureContext(db, clock, {token}));
}
export async function projectPublicProof(db: Database, link: ProofAccessLinkRow): Promise<PublicProofView> {
  return getDisclosureProjection(db, await disclosureContextForLink(db, link));
}
export const readPublicEvidence = (db:Database, clock:Clock, store:ObjectStore, token:string, evidenceId:string) => readDisclosedMedia(db,clock,store,token,evidenceId);
export function assertGuestCannotMutate(): never { throw new DomainError('PARTICIPANT_NOT_AUTHORIZED','A viewing link cannot change this Proof',403); }
