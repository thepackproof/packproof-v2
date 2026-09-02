import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { asRequiredIso } from "./types.js";
import { assertNotFinalized, loadProof, requireParticipant } from "./proof-access.js";
import { requireTransferType, type TransferStatus, type TransferType } from "./workflow.js";

export interface CustodyTransferRow {
  id: string;
  proof_id: string;
  from_observation_id: string;
  to_observation_id: string | null;
  transfer_type: TransferType | string;
  status: TransferStatus | string;
  carrier_context: unknown;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface TransferView {
  transferId: string;
  proofId: string;
  fromObservationId: string;
  toObservationId: string | null;
  transferType: string;
  status: string;
  carrierContext: Record<string, unknown>;
  intervalNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toTransferView(row: CustodyTransferRow): TransferView {
  const open = row.status === "OPEN" && !row.to_observation_id;
  return {
    transferId: row.id,
    proofId: row.proof_id,
    fromObservationId: row.from_observation_id,
    toObservationId: row.to_observation_id,
    transferType: row.transfer_type,
    status: row.status,
    carrierContext: asContext(row.carrier_context),
    intervalNote: open ? "No PackProof observation exists for this interval." : null,
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
  };
}

export async function listTransfers(db: Database, proofId: string): Promise<TransferView[]> {
  const found = await db.query<CustodyTransferRow>(
    `SELECT * FROM custody_transfers WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return found.rows.map(toTransferView);
}

export async function openTransfer(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    fromObservationId: string;
    transferType?: unknown;
    carrierContext?: unknown;
    idempotencyKey?: string | null;
  },
): Promise<TransferView> {
  const transferType = requireTransferType(input.transferType);
  const idempotencyKey = normalizeIdempotency(input.idempotencyKey);
  const carrierContext = asContext(input.carrierContext);
  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    await requireParticipant(tx, proofId, actorUserId, "SELLER");
    if (idempotencyKey) {
      const existing = await tx.query<CustodyTransferRow>(
        `SELECT * FROM custody_transfers WHERE proof_id = $1 AND idempotency_key = $2`,
        [proofId, idempotencyKey],
      );
      if (existing.rows[0]) {
        return toTransferView(existing.rows[0]);
      }
    }
    const from = await tx.query<{ id: string }>(
      `SELECT id FROM custody_observations WHERE id = $1 AND proof_id = $2`,
      [input.fromObservationId, proofId],
    );
    if (!from.rows[0]) {
      throw new DomainError("OBSERVATION_NOT_FOUND", "Release observation was not found", 404);
    }
    const id = newId("xfr");
    const now = clock.now().toISOString();
    try {
      await tx.query(
        `INSERT INTO custody_transfers (
           id, proof_id, from_observation_id, to_observation_id, transfer_type,
           status, carrier_context, idempotency_key, created_at, updated_at
         ) VALUES ($1, $2, $3, NULL, $4, 'OPEN', $5::jsonb, $6, $7, $7)`,
        [id, proofId, input.fromObservationId, transferType, JSON.stringify(carrierContext), idempotencyKey, now],
      );
    } catch (error) {
      if (isUniqueViolation(error) && idempotencyKey) {
        const raced = await tx.query<CustodyTransferRow>(
          `SELECT * FROM custody_transfers WHERE proof_id = $1 AND idempotency_key = $2`,
          [proofId, idempotencyKey],
        );
        if (raced.rows[0]) {
          return toTransferView(raced.rows[0]);
        }
      }
      throw error;
    }
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "CUSTODY_TRANSFER_OPENED",
      eventData: { transferId: id, fromObservationId: input.fromObservationId, transferType },
      at: clock.now(),
    });
    return toTransferView({
      id,
      proof_id: proofId,
      from_observation_id: input.fromObservationId,
      to_observation_id: null,
      transfer_type: transferType,
      status: "OPEN",
      carrier_context: carrierContext,
      idempotency_key: idempotencyKey,
      created_at: now,
      updated_at: now,
    });
  });
}

export async function closeTransfer(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: { transferId: string; toObservationId: string },
): Promise<TransferView> {
  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    await requireParticipant(tx, proofId, actorUserId, "BUYER");
    const found = await tx.query<CustodyTransferRow>(
      `SELECT * FROM custody_transfers WHERE id = $1 FOR UPDATE`,
      [input.transferId],
    );
    const row = found.rows[0];
    if (!row || row.proof_id !== proofId) {
      throw new DomainError(
        "TRANSFER_PROOF_MISMATCH",
        "Transfer does not belong to this Proof",
        409,
      );
    }
    const to = await tx.query<{ id: string }>(
      `SELECT id FROM custody_observations WHERE id = $1 AND proof_id = $2`,
      [input.toObservationId, proofId],
    );
    if (!to.rows[0]) {
      throw new DomainError("OBSERVATION_NOT_FOUND", "Receiving observation was not found", 404);
    }
    if (row.to_observation_id) {
      if (row.to_observation_id === input.toObservationId) {
        return toTransferView(row);
      }
      throw new DomainError("TRANSFER_ALREADY_RECEIVED", "This transfer already has a receiving observation", 409);
    }
    const now = clock.now().toISOString();
    await tx.query(
      `UPDATE custody_transfers
          SET to_observation_id = $2, status = 'RECEIVED', updated_at = $3
        WHERE id = $1`,
      [input.transferId, input.toObservationId, now],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "CUSTODY_TRANSFER_RECEIVED",
      eventData: { transferId: input.transferId, toObservationId: input.toObservationId },
      at: clock.now(),
    });
    return toTransferView({
      ...row,
      to_observation_id: input.toObservationId,
      status: "RECEIVED",
      updated_at: now,
    });
  });
}

function asContext(value: unknown): Record<string, unknown> {
  if (value == null || value === "") {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_TRANSFER", "carrierContext must be an object", 400);
  }
  return value as Record<string, unknown>;
}

function normalizeIdempotency(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const key = value.trim();
  return key || null;
}
