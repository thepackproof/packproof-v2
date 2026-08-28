import type { Database } from "../db/database.js";
import { DomainError } from "./errors.js";
import {
  asIso,
  asRequiredIso,
  type EvidenceRow,
  type ParticipantRow,
  type ProofRow,
  type TransactionRow,
} from "./types.js";

export interface ProofView {
  proofId: string;
  transactionId: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  manifestId: string | null;
  transaction: {
    externalReference: string | null;
    metadata: unknown;
  };
  participants: Array<{
    participantId: string;
    userId: string;
    role: string;
    status: "JOINED";
    joinedAt: string;
  }>;
  evidence: Array<{
    evidenceId: string;
    evidenceType: string;
    validationStatus: string;
    sha256: string | null;
    byteSize: number | null;
    committedAt: string | null;
  }>;
}

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
  const proof = await loadProof(db, proofId);
  const transaction = await db.query<TransactionRow>(
    `SELECT * FROM transactions WHERE id = $1`,
    [proof.transaction_id],
  );
  const txn = transaction.rows[0];
  if (!txn) {
    throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  }
  const participants = await db.query<ParticipantRow>(
    `SELECT * FROM proof_participants WHERE proof_id = $1 ORDER BY role ASC, joined_at ASC`,
    [proofId],
  );
  const evidence = await db.query<EvidenceRow>(
    `SELECT * FROM evidence WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );

  return {
    proofId: proof.id,
    transactionId: proof.transaction_id,
    status: proof.status,
    version: Number(proof.version),
    createdAt: asRequiredIso(proof.created_at),
    updatedAt: asRequiredIso(proof.updated_at),
    finalizedAt: asIso(proof.finalized_at),
    manifestId: proof.manifest_id,
    transaction: {
      externalReference: txn.external_reference,
      metadata: txn.transaction_metadata ?? {},
    },
    participants: participants.rows.map((row) => ({
      participantId: row.id,
      userId: row.user_id,
      role: row.role,
      status: "JOINED" as const,
      joinedAt: asRequiredIso(row.joined_at),
    })),
    evidence: evidence.rows.map((row) => ({
      evidenceId: row.id,
      evidenceType: row.evidence_type,
      validationStatus: row.validation_status,
      sha256: row.sha256,
      byteSize: row.byte_size == null ? null : Number(row.byte_size),
      committedAt: asIso(row.committed_at),
    })),
  };
}

export async function getProofForUser(
  db: Database,
  actorUserId: string,
  proofId: string,
): Promise<ProofView> {
  await requireParticipant(db, proofId, actorUserId);
  return getProofView(db, proofId);
}
