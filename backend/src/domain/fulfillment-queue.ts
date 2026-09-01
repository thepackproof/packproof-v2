import type { Database } from "../db/database.js";
import { asRequiredIso } from "./types.js";
import { asNullableNumber as asNumber } from "./transaction-fields.js";
import {
  listTransactionItems,
  synthesizeItemsFromLegacy,
  type TransactionItemView,
} from "./transaction-items.js";
import { evaluateFinalizeRequirements } from "./finalize-requirements.js";
import {
  requireParticipationPolicy,
  type ParticipationPolicy,
} from "./participation.js";

export type FulfillmentQueueFilter = "ready" | "completed" | "all";
export type FulfillmentWorkflowState =
  | "READY_TO_PACK"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "REMOVED_FROM_FULFILLMENT";

export interface FulfillmentQueueItem {
  transactionId: string;
  proofId: string;
  connectionId: string;
  provider: string;
  providerDisplay: string;
  externalAccountReference: string | null;
  externalOrderId: string;
  externalReference: string | null;
  items: TransactionItemView[];
  itemSummary: string;
  itemCount: number;
  transactionValue: number | null;
  currency: string | null;
  orderedAt: string | null;
  proofStatus: string;
  participationPolicy: ParticipationPolicy;
  sellerPackingAttested: boolean;
  evidenceCount: number;
  pendingEvidenceCount: number;
  fulfillmentCaptureCount: number;
  canComplete: boolean;
  workflowState: FulfillmentWorkflowState;
}

interface QueueRow {
  transaction_id: string;
  proof_id: string;
  connection_id: string;
  provider: string;
  adapter_key: string;
  external_account_reference: string | null;
  external_order_id: string;
  commerce_external_reference: string | null;
  transaction_external_reference: string | null;
  item_title: string | null;
  quantity: string | number | null;
  transaction_value: string | number | null;
  currency: string | null;
  ordered_at: Date | string | null;
  proof_status: string;
  participation_policy: string;
  eligibility: string;
  cancelled: boolean;
  fulfillment_state: string;
  packing_attested: boolean;
  evidence_count: string | number;
  pending_evidence_count: string | number;
  fulfillment_capture_count: string | number;
}

export async function listFulfillmentQueue(
  db: Database,
  actorUserId: string,
  filter: FulfillmentQueueFilter = "ready",
): Promise<FulfillmentQueueItem[]> {
  const found = await db.query<QueueRow>(
    `SELECT
        t.id AS transaction_id,
        p.id AS proof_id,
        c.id AS connection_id,
        c.provider,
        c.adapter_key,
        c.external_account_reference,
        r.external_order_id,
        r.external_reference AS commerce_external_reference,
        t.external_reference AS transaction_external_reference,
        t.item_title,
        t.quantity,
        t.transaction_value,
        t.currency,
        r.ordered_at,
        p.status AS proof_status,
        p.participation_policy,
        r.eligibility,
        r.cancelled,
        r.fulfillment_state,
        EXISTS (
          SELECT 1 FROM attestations a
           WHERE a.proof_id = p.id
             AND a.attested_by = $1
             AND a.statement = 'PACKED_DESCRIBED_ITEM'
        ) AS packing_attested,
        (
          SELECT COUNT(*) FROM evidence e
           WHERE e.proof_id = p.id AND e.validation_status = 'COMMITTED'
        ) AS evidence_count,
        (
          SELECT COUNT(*) FROM evidence e
           WHERE e.proof_id = p.id AND e.validation_status = 'PENDING'
        ) AS pending_evidence_count,
        (
          SELECT COUNT(*) FROM evidence e
           WHERE e.proof_id = p.id
             AND e.validation_status = 'COMMITTED'
             AND e.evidence_type = 'FULFILLMENT_CAPTURE'
        ) AS fulfillment_capture_count
       FROM commerce_order_records r
       JOIN integration_connections c ON c.id = r.connection_id
       JOIN transactions t ON t.id = r.transaction_id
       JOIN proofs p ON p.transaction_id = t.id
      WHERE c.owner_user_id = $1
        AND t.created_by = $1
      ORDER BY r.ordered_at ASC NULLS LAST, r.external_order_id ASC, p.id ASC`,
    [actorUserId],
  );

  const items: FulfillmentQueueItem[] = [];
  for (const row of found.rows) {
    const storedItems = await listTransactionItems(db, row.transaction_id);
    const viewItems =
      storedItems.length > 0
        ? storedItems
        : synthesizeItemsFromLegacy({
            itemTitle: row.item_title,
            itemDescription: null,
            quantity: asNumber(row.quantity),
            transactionValue: asNumber(row.transaction_value),
            currency: row.currency,
          });
    const packingAttested = Boolean(row.packing_attested);
    const evidenceCount = Number(row.evidence_count ?? 0);
    const pendingEvidenceCount = Number(row.pending_evidence_count ?? 0);
    const fulfillmentCaptureCount = Number(row.fulfillment_capture_count ?? 0);
    const participationPolicy = requireParticipationPolicy(row.participation_policy);
    const finalized = row.proof_status === "FINALIZED";
    const removed =
      row.eligibility !== "FULFILLMENT_ELIGIBLE" ||
      row.cancelled === true ||
      row.fulfillment_state === "CANCELLED";
    const workflowState: FulfillmentWorkflowState = finalized
      ? "COMPLETED"
      : removed
        ? "REMOVED_FROM_FULFILLMENT"
        : packingAttested || evidenceCount > 0
          ? "IN_PROGRESS"
          : "READY_TO_PACK";
    if (filter === "ready" && (workflowState === "COMPLETED" || workflowState === "REMOVED_FROM_FULFILLMENT")) {
      continue;
    }
    if (filter === "completed" && workflowState !== "COMPLETED") {
      continue;
    }
    const itemSummary =
      viewItems.length > 1
        ? `${viewItems[0]?.title ?? "Items"} + ${viewItems.length - 1} more`
        : (viewItems[0]?.title ?? row.item_title ?? "Order");
    items.push({
      transactionId: row.transaction_id,
      proofId: row.proof_id,
      connectionId: row.connection_id,
      provider: row.provider,
      providerDisplay: providerDisplay(row.adapter_key, row.provider),
      externalAccountReference: row.external_account_reference,
      externalOrderId: row.external_order_id,
      externalReference: row.commerce_external_reference ?? row.external_order_id,
      items: viewItems,
      itemSummary,
      itemCount: viewItems.length || Number(row.quantity ?? 0) || 1,
      transactionValue: asNumber(row.transaction_value),
      currency: row.currency,
      orderedAt: row.ordered_at ? asRequiredIso(row.ordered_at) : null,
      proofStatus: row.proof_status,
      participationPolicy,
      sellerPackingAttested: packingAttested,
      evidenceCount,
      pendingEvidenceCount,
      fulfillmentCaptureCount,
      canComplete:
        !finalized &&
        evaluateFinalizeRequirements({
          participationPolicy,
          proofStatus: row.proof_status,
          hasSeller: true,
          hasBuyer: true,
          pendingEvidenceCount,
          committedEvidenceCount: evidenceCount,
          committedFulfillmentCaptureCount: fulfillmentCaptureCount,
          packingAttested,
        }).ok,
      workflowState,
    });
  }
  return items;
}

export function parseFulfillmentQueueFilter(value: unknown): FulfillmentQueueFilter {
  if (value == null || value === "" || value === "ready") {
    return "ready";
  }
  if (value === "completed" || value === "all") {
    return value;
  }
  return "ready";
}

export function providerDisplay(adapterKey: string, provider: string): string {
  if (adapterKey === "demo-storefront" || provider === "demo-storefront") {
    return "Demo Storefront";
  }
  if (adapterKey === "ebay" || provider === "ebay") {
    return "eBay";
  }
  return provider;
}

export async function countReadyFulfillmentOrders(
  db: Database,
  connectionId: string,
  ownerUserId: string,
): Promise<number> {
  const queue = await listFulfillmentQueue(db, ownerUserId, "ready");
  return queue.filter((item) => item.connectionId === connectionId).length;
}
