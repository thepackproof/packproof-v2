import type { Database } from "../db/database.js";
import { asIso, asRequiredIso, type ParticipantRole, type ProofStatus } from "./types.js";

export const PROOF_COLLECTION_LIMIT = 100;

export interface ProofCollectionItem {
  proofId: string;
  transactionId: string;
  role: ParticipantRole;
  status: ProofStatus | string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  transaction: {
    externalReference: string | null;
    itemTitle: string | null;
    transactionDate: string | null;
    carrier: string | null;
    trackingNumber: string | null;
  };
}

interface CollectionRow {
  proof_id: string;
  transaction_id: string;
  role: ParticipantRole;
  status: ProofStatus;
  created_at: Date | string;
  updated_at: Date | string;
  finalized_at: Date | string | null;
  external_reference: string | null;
  item_title: string | null;
  transaction_date: string | null;
  carrier: string | null;
  tracking_number: string | null;
}

export async function listMyProofs(
  db: Database,
  actorUserId: string,
): Promise<ProofCollectionItem[]> {
  const found = await db.query<CollectionRow>(
    `SELECT
        p.id AS proof_id,
        p.transaction_id,
        pp.role,
        p.status,
        p.created_at,
        p.updated_at,
        p.finalized_at,
        t.external_reference,
        t.item_title,
        t.transaction_date,
        s.carrier,
        s.tracking_number
       FROM proof_participants pp
       JOIN proofs p ON p.id = pp.proof_id
       JOIN transactions t ON t.id = p.transaction_id
       LEFT JOIN transaction_shipping s ON s.transaction_id = t.id
      WHERE pp.user_id = $1
      ORDER BY
        CASE WHEN p.status = 'FINALIZED' THEN 1 ELSE 0 END ASC,
        CASE WHEN p.status = 'FINALIZED' THEN p.finalized_at ELSE p.updated_at END DESC,
        p.id DESC
      LIMIT $2`,
    [actorUserId, PROOF_COLLECTION_LIMIT],
  );

  return found.rows.map((row) => ({
    proofId: row.proof_id,
    transactionId: row.transaction_id,
    role: row.role,
    status: row.status,
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
    finalizedAt: asIso(row.finalized_at),
    transaction: {
      externalReference: row.external_reference,
      itemTitle: row.item_title,
      transactionDate: row.transaction_date,
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
    },
  }));
}
