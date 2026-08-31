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
  const existing = await db.query<CommerceOrderRecordRow>(
    `SELECT * FROM commerce_order_records
      WHERE commerce_tenant_key = $1 AND external_order_id = $2`,
    [input.commerceTenantKey, input.externalOrderId],
  );
  if (existing.rows[0]) {
    await db.query(
      `UPDATE commerce_order_records
          SET connection_id = $2,
              external_reference = $3,
              ordered_at = $4,
              payment_state = $5,
              fulfillment_state = $6,
              requires_physical_fulfillment = $7,
              cancelled = $8,
              eligibility = $9,
              provider_updated_at = $10,
              last_seen_at = $11,
              normalized_fingerprint = $12
        WHERE id = $1`,
      [
        existing.rows[0].id,
        input.connectionId,
        input.externalReference,
        input.orderedAt,
        input.paymentState,
        input.fulfillmentState,
        input.requiresPhysicalFulfillment,
        input.cancelled,
        input.eligibility,
        input.providerUpdatedAt,
        now,
        input.fingerprint,
      ],
    );
    const updated = await db.query<CommerceOrderRecordRow>(
      `SELECT * FROM commerce_order_records WHERE id = $1`,
      [existing.rows[0].id],
    );
    return updated.rows[0];
  }
  const id = newId("cor");
  await db.query(
    `INSERT INTO commerce_order_records (
       id, connection_id, transaction_id, commerce_tenant_key, external_order_id,
       external_reference, ordered_at, payment_state, fulfillment_state,
       requires_physical_fulfillment, cancelled, eligibility, provider_updated_at,
       first_seen_at, last_seen_at, normalized_fingerprint
     ) VALUES (
       $1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14
     )`,
    [
      id,
      input.connectionId,
      input.commerceTenantKey,
      input.externalOrderId,
      input.externalReference,
      input.orderedAt,
      input.paymentState,
      input.fulfillmentState,
      input.requiresPhysicalFulfillment,
      input.cancelled,
      input.eligibility,
      input.providerUpdatedAt,
      now,
      input.fingerprint,
    ],
  );
  const inserted = await db.query<CommerceOrderRecordRow>(
    `SELECT * FROM commerce_order_records WHERE id = $1`,
    [id],
  );
  return inserted.rows[0];
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
       provider_cursor = COALESCE(EXCLUDED.provider_cursor, commerce_connection_sync_states.provider_cursor),
       updated_at = EXCLUDED.updated_at`,
    [
      input.connectionId,
      now,
      input.succeeded ? now : null,
      input.succeeded ? null : (input.errorCode ?? null),
      input.succeeded ? null : (input.retryable ?? null),
      input.providerCursor ?? null,
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
} {
  return {
    lastAttemptedAt: row?.last_attempted_at ? asRequiredIso(row.last_attempted_at) : null,
    lastSucceededAt: row?.last_succeeded_at ? asIso(row.last_succeeded_at) : null,
    lastErrorCode: row?.last_error_code ?? null,
    retryable: row?.last_error_retryable ?? null,
  };
}
