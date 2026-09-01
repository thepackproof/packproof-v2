import type { Database } from "../db/database.js";
import { DomainError } from "./errors.js";
import { blockReasonForProof, formatItemSummary, formatOrderLabel } from "./packing-station-display.js";
import type { ParticipationPolicy } from "./participation.js";
import { requireParticipationPolicy } from "./participation.js";
import { listTransactionItems, synthesizeItemsFromLegacy } from "./transaction-items.js";
import { asNullableNumber } from "./transaction-fields.js";
import type { ProofRow, ShippingRow, TransactionRow } from "./types.js";

export const PACKING_STATION_RESOLVE_SCHEMA = "packproof.packing-station.resolve/v1" as const;

export type StationMatchKind =
  | "PROOF_ID"
  | "TRANSACTION_ID"
  | "TRACKING_NUMBER"
  | "EXTERNAL_ORDER_ID"
  | "INTEGRATION_IDENTITY"
  | "EXTERNAL_REFERENCE";

export interface PackingStationResolveView {
  schema: typeof PACKING_STATION_RESOLVE_SCHEMA;
  reference: string;
  matchedBy: StationMatchKind;
  transactionId: string;
  proofId: string | null;
  proofStatus: string | null;
  participationPolicy: ParticipationPolicy | null;
  orderLabel: string;
  itemSummary: string;
  committedEvidenceCount: number;
  captureReady: boolean;
  alreadyFinalized: boolean;
  alreadyHasCommittedEvidence: boolean;
  blockReason: ReturnType<typeof blockReasonForProof>;
}

interface MatchRow {
  transaction_id: string;
  matched_by: StationMatchKind;
}

export function normalizeStationReference(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^#+/, "")
    .trim();
}

export function parseStationResolveRequest(body: unknown): { reference: string } {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const reference = normalizeStationReference(record.reference ?? record.q ?? record.externalReference);
  if (!reference) {
    throw new DomainError(
      "STATION_REFERENCE_INVALID",
      "An order, tracking, or transaction reference is required",
      400,
    );
  }
  if (reference.length > 200) {
    throw new DomainError(
      "STATION_REFERENCE_INVALID",
      "Reference is too long",
      400,
    );
  }
  return { reference };
}

export async function resolvePackingStationTarget(
  db: Database,
  actorUserId: string,
  input: { reference: string },
): Promise<PackingStationResolveView> {
  const reference = normalizeStationReference(input.reference);
  if (!reference) {
    throw new DomainError(
      "STATION_REFERENCE_INVALID",
      "An order, tracking, or transaction reference is required",
      400,
    );
  }

  const matches = await findAuthorizedMatches(db, actorUserId, reference);
  const unique = new Map<string, StationMatchKind>();
  for (const match of matches) {
    const current = unique.get(match.transaction_id);
    if (!current || matchPriority(match.matched_by) < matchPriority(current)) {
      unique.set(match.transaction_id, match.matched_by);
    }
  }

  if (unique.size === 0) {
    throw new DomainError(
      "STATION_REFERENCE_NOT_FOUND",
      "No packing order matched that reference",
      404,
    );
  }
  if (unique.size > 1) {
    throw new DomainError(
      "STATION_REFERENCE_AMBIGUOUS",
      "More than one order matched that reference",
      409,
    );
  }

  const [transactionId, matchedBy] = [...unique.entries()][0] as [string, StationMatchKind];
  return loadResolveView(db, actorUserId, transactionId, reference, matchedBy);
}

async function findAuthorizedMatches(
  db: Database,
  actorUserId: string,
  reference: string,
): Promise<MatchRow[]> {
  if (looksLikePrefixedId(reference, "proof")) {
    const found = await db.query<MatchRow>(
      `SELECT t.id AS transaction_id, 'PROOF_ID'::text AS matched_by
         FROM proofs p
         JOIN transactions t ON t.id = p.transaction_id
         LEFT JOIN proof_participants seller
           ON seller.proof_id = p.id AND seller.role = 'SELLER'
        WHERE p.id = $1
          AND (t.created_by = $2 OR seller.user_id = $2)`,
      [reference, actorUserId],
    );
    return found.rows;
  }
  if (looksLikePrefixedId(reference, "txn")) {
    const found = await db.query<MatchRow>(
      `SELECT t.id AS transaction_id, 'TRANSACTION_ID'::text AS matched_by
         FROM transactions t
         LEFT JOIN proofs p ON p.transaction_id = t.id
         LEFT JOIN proof_participants seller
           ON seller.proof_id = p.id AND seller.role = 'SELLER'
        WHERE t.id = $1
          AND (t.created_by = $2 OR seller.user_id = $2)`,
      [reference, actorUserId],
    );
    return found.rows;
  }

  const needle = reference.toLowerCase();
  const found = await db.query<MatchRow>(
    `SELECT t.id AS transaction_id,
            CASE
              WHEN LOWER(ship.tracking_number) = $1 THEN 'TRACKING_NUMBER'
              WHEN LOWER(r.external_order_id) = $1 THEN 'EXTERNAL_ORDER_ID'
              WHEN LOWER(r.external_reference) = $1 THEN 'EXTERNAL_ORDER_ID'
              WHEN LOWER(i.external_transaction_id) = $1 THEN 'INTEGRATION_IDENTITY'
              WHEN LOWER(t.external_reference) = $1 THEN 'EXTERNAL_REFERENCE'
              ELSE 'EXTERNAL_REFERENCE'
            END AS matched_by
       FROM transactions t
       LEFT JOIN proofs p ON p.transaction_id = t.id
       LEFT JOIN proof_participants seller
         ON seller.proof_id = p.id AND seller.role = 'SELLER'
       LEFT JOIN transaction_shipping ship ON ship.transaction_id = t.id
       LEFT JOIN commerce_order_records r ON r.transaction_id = t.id
       LEFT JOIN transaction_integration_identities i ON i.transaction_id = t.id
      WHERE (t.created_by = $2 OR seller.user_id = $2)
        AND (
          LOWER(t.external_reference) = $1
          OR LOWER(ship.tracking_number) = $1
          OR LOWER(r.external_order_id) = $1
          OR LOWER(r.external_reference) = $1
          OR LOWER(i.external_transaction_id) = $1
        )`,
    [needle, actorUserId],
  );
  return found.rows;
}

async function loadResolveView(
  db: Database,
  actorUserId: string,
  transactionId: string,
  reference: string,
  matchedBy: StationMatchKind,
): Promise<PackingStationResolveView> {
  const txn = await db.query<TransactionRow>(`SELECT * FROM transactions WHERE id = $1`, [
    transactionId,
  ]);
  const row = txn.rows[0];
  if (!row) {
    throw new DomainError("STATION_REFERENCE_NOT_FOUND", "No packing order matched that reference", 404);
  }
  const proof = await db.query<ProofRow>(`SELECT * FROM proofs WHERE transaction_id = $1`, [
    transactionId,
  ]);
  const proofRow = proof.rows[0] ?? null;
  if (row.created_by !== actorUserId) {
    if (!proofRow) {
      throw new DomainError("STATION_REFERENCE_NOT_FOUND", "No packing order matched that reference", 404);
    }
    const seller = await db.query<{ user_id: string }>(
      `SELECT user_id FROM proof_participants WHERE proof_id = $1 AND role = 'SELLER'`,
      [proofRow.id],
    );
    if (seller.rows[0]?.user_id !== actorUserId) {
      throw new DomainError("STATION_REFERENCE_NOT_FOUND", "No packing order matched that reference", 404);
    }
  }

  const shipping = await db.query<ShippingRow>(
    `SELECT * FROM transaction_shipping WHERE transaction_id = $1`,
    [transactionId],
  );
  const commerce = await db.query<{ external_order_id: string | null; external_reference: string | null }>(
    `SELECT external_order_id, external_reference
       FROM commerce_order_records
      WHERE transaction_id = $1
      ORDER BY ordered_at ASC NULLS LAST, external_order_id ASC
      LIMIT 1`,
    [transactionId],
  );
  const storedItems = await listTransactionItems(db, transactionId);
  const items =
    storedItems.length > 0
      ? storedItems
      : synthesizeItemsFromLegacy({
          itemTitle: row.item_title,
          itemDescription: row.item_description,
          quantity: asNullableNumber(row.quantity),
          transactionValue: asNullableNumber(row.transaction_value),
          currency: row.currency,
        });
  const committed = proofRow
    ? await db.query<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM evidence
          WHERE proof_id = $1 AND validation_status = 'COMMITTED'`,
        [proofRow.id],
      )
    : { rows: [{ n: 0 }] };
  const committedEvidenceCount = Number(committed.rows[0]?.n ?? 0);
  const proofStatus = proofRow?.status ?? null;
  const alreadyFinalized = proofStatus === "FINALIZED";
  const blockReason = blockReasonForProof(proofStatus, committedEvidenceCount);
  const orderRef =
    commerce.rows[0]?.external_reference ??
    commerce.rows[0]?.external_order_id ??
    row.external_reference ??
    shipping.rows[0]?.tracking_number ??
    reference;
  const itemSummary =
    items.length > 1
      ? formatItemSummary(items[0]?.title ?? row.item_title, items.length - 1)
      : formatItemSummary(items[0]?.title ?? row.item_title);

  return {
    schema: PACKING_STATION_RESOLVE_SCHEMA,
    reference,
    matchedBy,
    transactionId,
    proofId: proofRow?.id ?? null,
    proofStatus,
    participationPolicy: proofRow
      ? requireParticipationPolicy(proofRow.participation_policy)
      : null,
    orderLabel: formatOrderLabel(orderRef),
    itemSummary,
    committedEvidenceCount,
    captureReady: blockReason == null && proofStatus === "READY_FOR_EVIDENCE" && committedEvidenceCount === 0,
    alreadyFinalized,
    alreadyHasCommittedEvidence: committedEvidenceCount > 0,
    blockReason,
  };
}

function looksLikePrefixedId(value: string, prefix: string): boolean {
  return value.startsWith(`${prefix}_`) && value.length > prefix.length + 8;
}

function matchPriority(kind: StationMatchKind): number {
  switch (kind) {
    case "PROOF_ID":
      return 0;
    case "TRANSACTION_ID":
      return 1;
    case "TRACKING_NUMBER":
      return 2;
    case "EXTERNAL_ORDER_ID":
      return 3;
    case "INTEGRATION_IDENTITY":
      return 4;
    default:
      return 5;
  }
}
