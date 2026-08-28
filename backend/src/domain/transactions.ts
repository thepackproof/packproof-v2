import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { asRequiredIso, type TransactionRow } from "./types.js";

export interface TransactionView {
  transactionId: string;
  externalReference: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  metadata: unknown;
}

export function toTransactionView(row: TransactionRow): TransactionView {
  return {
    transactionId: row.id,
    externalReference: row.external_reference,
    createdBy: row.created_by,
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
    metadata: row.transaction_metadata ?? {},
  };
}

export async function createTransaction(
  db: Database,
  clock: Clock,
  actorUserId: string,
  input: { externalReference?: string | null; metadata?: unknown },
): Promise<TransactionView> {
  const externalReference = input.externalReference?.trim() || null;
  const metadata = input.metadata ?? {};

  return db.transaction(async (tx) => {
    if (externalReference) {
      const existing = await tx.query<TransactionRow>(
        `SELECT * FROM transactions WHERE external_reference = $1`,
        [externalReference],
      );
      if (existing.rows[0]) {
        return toTransactionView(existing.rows[0]);
      }
    }

    const id = newId("txn");
    const now = clock.now().toISOString();
    try {
      await tx.query(
        `INSERT INTO transactions (
           id, external_reference, created_by, created_at, updated_at, transaction_metadata
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [id, externalReference, actorUserId, now, now, JSON.stringify(metadata)],
      );
    } catch (error) {
      if (externalReference && isUniqueViolation(error)) {
        const raced = await tx.query<TransactionRow>(
          `SELECT * FROM transactions WHERE external_reference = $1`,
          [externalReference],
        );
        if (raced.rows[0]) {
          return toTransactionView(raced.rows[0]);
        }
      }
      throw error;
    }

    return {
      transactionId: id,
      externalReference,
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
      metadata,
    };
  });
}

export async function getTransaction(
  db: Database,
  actorUserId: string,
  transactionId: string,
): Promise<TransactionView> {
  const result = await db.query<TransactionRow>(
    `SELECT * FROM transactions WHERE id = $1`,
    [transactionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  }
  if (row.created_by !== actorUserId) {
    const viaProof = await db.query<{ id: string }>(
      `SELECT p.id
         FROM proofs p
         JOIN proof_participants pp ON pp.proof_id = p.id
        WHERE p.transaction_id = $1 AND pp.user_id = $2`,
      [transactionId, actorUserId],
    );
    if (!viaProof.rows[0]) {
      throw new DomainError("PARTICIPANT_NOT_AUTHORIZED", "Not allowed to read this transaction", 403);
    }
  }
  return toTransactionView(row);
}
