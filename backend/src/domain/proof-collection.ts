import type { Database } from "../db/database.js";
import { PROOF_SUMMARY_SCHEMA } from "./trust.js";
import { asNullableNumber } from "./transaction-fields.js";
import { asIso, asRequiredIso, type ParticipantRole, type ProofStatus } from "./types.js";

export const PROOF_COLLECTION_LIMIT = 100;

export interface ProofCollectionItem {
  schema: typeof PROOF_SUMMARY_SCHEMA;
  proofId: string;
  transactionId: string;
  role: ParticipantRole;
  status: ProofStatus | string;
  workflowType?: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  transaction: {
    externalReference: string | null;
    itemTitle: string | null;
    transactionDate: string | null;
    carrier: string | null;
    trackingNumber: string | null;
    service: string | null;
    transactionValue: number | null;
    currency: string | null;
  };
}

interface CollectionRow {
  proof_id: string;
  transaction_id: string;
  role: ParticipantRole;
  status: ProofStatus;
  workflow_type?: string;
  created_at: Date | string;
  updated_at: Date | string;
  finalized_at: Date | string | null;
  external_reference: string | null;
  item_title: string | null;
  transaction_date: string | null;
  carrier: string | null;
  tracking_number: string | null;
  service: string | null;
  transaction_value: string | number | null;
  currency: string | null;
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
        p.workflow_type,
        p.created_at,
        p.updated_at,
        p.finalized_at,
        t.external_reference,
        t.item_title,
        t.transaction_date,
        s.carrier,
        s.tracking_number,
        s.service,
        t.transaction_value,
        t.currency
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
    schema: PROOF_SUMMARY_SCHEMA,
    proofId: row.proof_id,
    transactionId: row.transaction_id,
    role: row.role,
    status: row.status,
    workflowType: row.workflow_type ?? "COMMERCE_SALE",
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
    finalizedAt: asIso(row.finalized_at),
    transaction: {
      externalReference: row.external_reference,
      itemTitle: row.item_title,
      transactionDate: row.transaction_date,
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      service: row.service,
      transactionValue: asNullableNumber(row.transaction_value),
      currency: row.currency,
    },
  }));
}
