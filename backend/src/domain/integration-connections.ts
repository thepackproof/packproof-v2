import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { integrationNotFound } from "./integration-errors.js";
import { asRequiredIso } from "./types.js";

export type IntegrationConnectionStatus = "ACTIVE" | "DISABLED" | "NEEDS_REAUTH";

export interface IntegrationConnectionRow {
  id: string;
  owner_user_id: string;
  adapter_key: string;
  provider: string;
  external_account_reference: string | null;
  credential_reference: string;
  status: IntegrationConnectionStatus | string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface IntegrationConnectionView {
  connectionId: string;
  adapterKey: string;
  provider: string;
  status: string;
  externalAccountReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShipmentSyncAvailability {
  available: boolean;
  connectionId: string | null;
  adapterKey: string | null;
  provider: string | null;
  status: string | null;
}

export function toConnectionView(row: IntegrationConnectionRow): IntegrationConnectionView {
  return {
    connectionId: row.id,
    adapterKey: row.adapter_key,
    provider: row.provider,
    status: row.status,
    externalAccountReference: row.external_account_reference,
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
  };
}

export async function createIntegrationConnection(
  db: Database,
  clock: Clock,
  ownerUserId: string,
  input: {
    adapterKey: string;
    provider: string;
    credentialReference: string;
    externalAccountReference?: string | null;
    status?: IntegrationConnectionStatus;
  },
): Promise<IntegrationConnectionView> {
  const id = newId("icn");
  const now = clock.now().toISOString();
  await db.query(
    `INSERT INTO integration_connections (
       id, owner_user_id, adapter_key, provider, external_account_reference,
       credential_reference, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      ownerUserId,
      input.adapterKey,
      input.provider,
      input.externalAccountReference ?? null,
      input.credentialReference,
      input.status ?? "ACTIVE",
      now,
      now,
    ],
  );
  const found = await loadConnection(db, id);
  return toConnectionView(found);
}

export async function loadConnection(
  db: Database,
  connectionId: string,
): Promise<IntegrationConnectionRow> {
  const found = await db.query<IntegrationConnectionRow>(
    `SELECT * FROM integration_connections WHERE id = $1`,
    [connectionId],
  );
  const row = found.rows[0];
  if (!row) {
    throw integrationNotFound();
  }
  return row;
}

export async function bindTransactionShipmentConnection(
  db: Database,
  clock: Clock,
  actorUserId: string,
  transactionId: string,
  connectionId: string,
): Promise<ShipmentSyncAvailability> {
  const connection = await loadConnection(db, connectionId);
  if (connection.owner_user_id !== actorUserId) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Not allowed to bind this integration connection",
      403,
    );
  }
  const txn = await db.query<{ id: string; created_by: string }>(
    `SELECT id, created_by FROM transactions WHERE id = $1`,
    [transactionId],
  );
  if (!txn.rows[0]) {
    throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  }
  if (txn.rows[0].created_by !== actorUserId) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Only the seller can associate a trusted shipment integration",
      403,
    );
  }
  const now = clock.now().toISOString();
  await db.query(
    `INSERT INTO transaction_shipment_connections (transaction_id, connection_id, created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (transaction_id) DO UPDATE SET connection_id = EXCLUDED.connection_id`,
    [transactionId, connectionId, now],
  );
  return getShipmentSyncAvailability(db, transactionId);
}

export async function getShipmentSyncAvailability(
  db: Database,
  transactionId: string,
): Promise<ShipmentSyncAvailability> {
  const found = await db.query<IntegrationConnectionRow>(
    `SELECT c.*
       FROM transaction_shipment_connections b
       JOIN integration_connections c ON c.id = b.connection_id
      WHERE b.transaction_id = $1`,
    [transactionId],
  );
  const row = found.rows[0];
  if (!row) {
    return {
      available: false,
      connectionId: null,
      adapterKey: null,
      provider: null,
      status: null,
    };
  }
  return {
    available: row.status === "ACTIVE",
    connectionId: row.id,
    adapterKey: row.adapter_key,
    provider: row.provider,
    status: row.status,
  };
}

export async function loadBoundConnection(
  db: Database,
  transactionId: string,
): Promise<IntegrationConnectionRow> {
  const found = await db.query<IntegrationConnectionRow>(
    `SELECT c.*
       FROM transaction_shipment_connections b
       JOIN integration_connections c ON c.id = b.connection_id
      WHERE b.transaction_id = $1`,
    [transactionId],
  );
  const row = found.rows[0];
  if (!row) {
    throw integrationNotFound();
  }
  return row;
}

export async function findBoundConnectionByTracking(
  db: Database,
  adapterKey: string,
  trackingNumber: string,
): Promise<{ connection: IntegrationConnectionRow; transactionId: string } | null> {
  const found = await db.query<IntegrationConnectionRow & { transaction_id: string }>(
    `SELECT c.*, b.transaction_id
       FROM transaction_shipping s
       JOIN transaction_shipment_connections b ON b.transaction_id = s.transaction_id
       JOIN integration_connections c ON c.id = b.connection_id
      WHERE s.tracking_number = $1
        AND c.adapter_key = $2
      ORDER BY b.created_at ASC, c.id ASC`,
    [trackingNumber, adapterKey],
  );
  if (found.rows.length === 0) {
    return null;
  }
  if (found.rows.length > 1) {
    throw new DomainError(
      "SHIPMENT_EVENT_CONFLICT",
      "Tracking number matches more than one trusted shipment connection",
      409,
    );
  }
  const row = found.rows[0];
  return { connection: row, transactionId: row.transaction_id };
}

export async function listActiveConnectionsForAdapter(
  db: Database,
  adapterKey: string,
): Promise<IntegrationConnectionRow[]> {
  const found = await db.query<IntegrationConnectionRow>(
    `SELECT * FROM integration_connections
      WHERE adapter_key = $1 AND status = 'ACTIVE'
      ORDER BY created_at ASC, id ASC`,
    [adapterKey],
  );
  return found.rows;
}

export async function updateConnectionStatus(
  db: Database,
  clock: Clock,
  connectionId: string,
  status: IntegrationConnectionStatus,
): Promise<void> {
  await db.query(
    `UPDATE integration_connections SET status = $2, updated_at = $3 WHERE id = $1`,
    [connectionId, status, clock.now().toISOString()],
  );
}

export async function recordShipmentSyncState(
  db: Database,
  clock: Clock,
  input: {
    transactionId: string;
    connectionId: string;
    succeeded: boolean;
    errorCode?: string | null;
    retryable?: boolean | null;
  },
): Promise<void> {
  const now = clock.now().toISOString();
  await db.query(
    `INSERT INTO shipment_sync_states (
       transaction_id, connection_id, last_attempted_at, last_succeeded_at,
       last_error_code, last_error_retryable, provider_cursor, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $3)
     ON CONFLICT (transaction_id) DO UPDATE SET
       connection_id = EXCLUDED.connection_id,
       last_attempted_at = EXCLUDED.last_attempted_at,
       last_succeeded_at = COALESCE(EXCLUDED.last_succeeded_at, shipment_sync_states.last_succeeded_at),
       last_error_code = EXCLUDED.last_error_code,
       last_error_retryable = EXCLUDED.last_error_retryable,
       updated_at = EXCLUDED.updated_at`,
    [
      input.transactionId,
      input.connectionId,
      now,
      input.succeeded ? now : null,
      input.succeeded ? null : (input.errorCode ?? null),
      input.succeeded ? null : (input.retryable ?? null),
    ],
  );
}
