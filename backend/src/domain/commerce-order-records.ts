import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import {
  type FulfillmentEligibility,
  type NormalizedFulfillmentState,
  type NormalizedPaymentState,
} from "./fulfillment-eligibility.js";
import { asIso, asRequiredIso } from "./types.js";

export interface CommerceOrderRecordRow {
  id: string;
  connection_id: string;
  transaction_id: string | null;
  commerce_tenant_key: string;
  external_order_id: string;
  external_reference: string | null;
  ordered_at: Date | string | null;
  payment_state: NormalizedPaymentState | string;
  fulfillment_state: NormalizedFulfillmentState | string;
  requires_physical_fulfillment: boolean;
  cancelled: boolean;
  eligibility: FulfillmentEligibility | string;
  provider_updated_at: Date | string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  normalized_fingerprint: string;
}

export interface CommerceSyncStateRow {
  connection_id: string;
  last_attempted_at: Date | string | null;
  last_succeeded_at: Date | string | null;
  last_error_code: string | null;
  last_error_retryable: boolean | null;
  provider_cursor: string | null;
  updated_at: Date | string;
  run_status: string;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  next_run_at: Date | string | null;
  window_started_at: Date | string | null;
  window_ended_at: Date | string | null;
  initial_sync_completed_at: Date | string | null;
  last_reconciled_at: Date | string | null;
  reconciliation_pass: boolean;
  discovered_count: number;
  eligible_count: number;
}

export async function upsertCommerceOrderRecord(
  db: Database,
  clock: Clock,
  input: {
    connectionId: string;
    commerceTenantKey: string;
    externalOrderId: string;
    externalReference: string | null;
    orderedAt: string | null;
    paymentState: string;
    fulfillmentState: string;
    requiresPhysicalFulfillment: boolean;
    cancelled: boolean;
    eligibility: FulfillmentEligibility;
    providerUpdatedAt: string | null;
    fingerprint: string;
  },
): Promise<CommerceOrderRecordRow> {
  const now = clock.now().toISOString();
  const result = await db.query<CommerceOrderRecordRow>(
    `INSERT INTO commerce_order_records (
      id,connection_id,commerce_tenant_key,external_order_id,external_reference,ordered_at,
      payment_state,fulfillment_state,requires_physical_fulfillment,cancelled,eligibility,
      provider_updated_at,first_seen_at,last_seen_at,normalized_fingerprint
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14)
    ON CONFLICT(commerce_tenant_key,external_order_id) DO UPDATE SET
      connection_id=EXCLUDED.connection_id,last_seen_at=EXCLUDED.last_seen_at
    RETURNING *`,
    [newId("cor"),input.connectionId,input.commerceTenantKey,input.externalOrderId,
     input.externalReference,input.orderedAt,input.paymentState,input.fulfillmentState,
     input.requiresPhysicalFulfillment,input.cancelled,input.eligibility,input.providerUpdatedAt,
     now,input.fingerprint],
  );
  const current = result.rows[0];
  // Monotonic provider revision under the row lock held by the ingestion transaction.
  if (current.provider_updated_at && (!input.providerUpdatedAt ||
      new Date(current.provider_updated_at).getTime() > Date.parse(input.providerUpdatedAt))) return current;
  const updated = await db.query<CommerceOrderRecordRow>(
    `UPDATE commerce_order_records SET external_reference=$2,ordered_at=$3,payment_state=$4,
      fulfillment_state=$5,requires_physical_fulfillment=$6,cancelled=$7,eligibility=$8,
      provider_updated_at=$9,normalized_fingerprint=$10 WHERE id=$1 RETURNING *`,
    [current.id,input.externalReference,input.orderedAt,input.paymentState,input.fulfillmentState,
     input.requiresPhysicalFulfillment,input.cancelled,input.eligibility,input.providerUpdatedAt,input.fingerprint],
  );
  return updated.rows[0];
}

export async function bindCommerceOrderTransaction(
  db: Database,
  recordId: string,
  transactionId: string,
): Promise<void> {
  await db.query(
    `UPDATE commerce_order_records
        SET transaction_id = COALESCE(transaction_id, $2)
      WHERE id = $1`,
    [recordId, transactionId],
  );
}

export async function recordCommerceSyncState(
  db: Database,
  clock: Clock,
  input: {
    connectionId: string;
    succeeded: boolean;
    errorCode?: string | null;
    retryable?: boolean | null;
    providerCursor?: string | null;
  },
): Promise<void> {
  const now = clock.now().toISOString();
  await db.query(
    `INSERT INTO commerce_connection_sync_states (
       connection_id, last_attempted_at, last_succeeded_at,
       last_error_code, last_error_retryable, provider_cursor, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $2)
     ON CONFLICT (connection_id) DO UPDATE SET
       last_attempted_at = EXCLUDED.last_attempted_at,
       last_succeeded_at = COALESCE(EXCLUDED.last_succeeded_at, commerce_connection_sync_states.last_succeeded_at),
       last_error_code = EXCLUDED.last_error_code,
       last_error_retryable = EXCLUDED.last_error_retryable,
       provider_cursor = CASE WHEN $7::boolean THEN EXCLUDED.provider_cursor ELSE commerce_connection_sync_states.provider_cursor END,
       updated_at = EXCLUDED.updated_at`,
    [
      input.connectionId,
      now,
      input.succeeded ? now : null,
      input.succeeded ? null : (input.errorCode ?? null),
      input.succeeded ? null : (input.retryable ?? null),
      input.providerCursor ?? null,
      input.succeeded,
    ],
  );
}

export async function loadCommerceSyncState(
  db: Database,
  connectionId: string,
): Promise<CommerceSyncStateRow | null> {
  const found = await db.query<CommerceSyncStateRow>(
    `SELECT * FROM commerce_connection_sync_states WHERE connection_id = $1`,
    [connectionId],
  );
  return found.rows[0] ?? null;
}

export function syncStateView(row: CommerceSyncStateRow | null): {
  lastAttemptedAt: string | null;
  lastSucceededAt: string | null;
  lastErrorCode: string | null;
  retryable: boolean | null;
  runStatus: string;
  attemptCount: number;
  nextRunAt: string | null;
  initialSyncCompletedAt: string | null;
  discoveredCount: number;
  eligibleCount: number;
} {
  return {
    lastAttemptedAt: row?.last_attempted_at ? asRequiredIso(row.last_attempted_at) : null,
    lastSucceededAt: row?.last_succeeded_at ? asIso(row.last_succeeded_at) : null,
    lastErrorCode: row?.last_error_code ?? null,
    retryable: row?.last_error_retryable ?? null,
    runStatus: row?.run_status ?? "IDLE",
    attemptCount: row?.attempt_count ?? 0,
    nextRunAt: row?.next_run_at ? asIso(row.next_run_at) : null,
    initialSyncCompletedAt: row?.initial_sync_completed_at ? asIso(row.initial_sync_completed_at) : null,
    discoveredCount: row?.discovered_count ?? 0,
    eligibleCount: row?.eligible_count ?? 0,
  };
}
