import type { Database } from "../db/database.js";
import { getCanonicalProof, type CanonicalProof } from "./canonical-proof.js";
import { DomainError } from "./errors.js";
import type { ParticipantRow, ProofRow } from "./types.js";

export type ProofView = CanonicalProof;

export async function loadProof(
  db: Database,
  proofId: string,
  forUpdate = false,
): Promise<ProofRow> {
  const sql = forUpdate
    ? `SELECT * FROM proofs WHERE id = $1 FOR UPDATE`
    : `SELECT * FROM proofs WHERE id = $1`;
  const result = await db.query<ProofRow>(sql, [proofId]);
  const row = result.rows[0];
  if (!row) {
    throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
  }
  return row;
}

export async function requireParticipant(
  db: Database,
  proofId: string,
  userId: string,
  role?: "SELLER" | "BUYER",
): Promise<ParticipantRow> {
  return authorizeProofAccess(db, proofId, userId, role);
}

export async function authorizeProofAccess(
  db: Database,
  proofId: string,
  userId: string,
  role?: "SELLER" | "BUYER",
): Promise<ParticipantRow> {
  const result = await db.query<ParticipantRow>(
    role
      ? `SELECT * FROM proof_participants WHERE proof_id = $1 AND user_id = $2 AND role = $3`
      : `SELECT * FROM proof_participants WHERE proof_id = $1 AND user_id = $2`,
    role ? [proofId, userId, role] : [proofId, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Not a participant of this Proof",
      403,
    );
  }
  return row;
}

export function assertNotFinalized(proof: ProofRow): void {
  if (proof.status === "FINALIZED") {
    throw new DomainError(
      "PROOF_ALREADY_FINALIZED",
      "Finalized Proofs cannot mutate",
      409,
    );
  }
}

export async function getProofView(db: Database, proofId: string): Promise<ProofView> {
  return getCanonicalProof(db, proofId);
}

export async function getProofForUser(
  db: Database,
  actorUserId: string,
  proofId: string,
): Promise<ProofView> {
  await authorizeProofAccess(db, proofId, actorUserId);
  return getProofView(db, proofId);
}
