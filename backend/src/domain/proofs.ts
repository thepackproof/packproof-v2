import type { Database } from "../db/database.js";
import { getCanonicalProof, type CanonicalProof } from "./canonical-proof.js";
import {
  assertNotFinalized,
  authorizeProofAccess,
  loadProof,
  requireParticipant,
} from "./proof-access.js";

export type ProofView = CanonicalProof;
export { assertNotFinalized, authorizeProofAccess, loadProof, requireParticipant };

export async function getProofView(
  db: Database,
  proofId: string,
  actorUserId?: string | null,
): Promise<ProofView> {
  return getCanonicalProof(db, proofId, actorUserId);
}

export async function getProofForUser(
  db: Database,
  actorUserId: string,
  proofId: string,
): Promise<ProofView> {
  await authorizeProofAccess(db, proofId, actorUserId);
  return getProofView(db, proofId, actorUserId);
}
