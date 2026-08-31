import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { IntegrationCredentialStore } from "../integrations/credentials.js";
import { logIntegrationEvent } from "../integrations/log.js";
import type { IntegrationAdapterRegistry } from "../integrations/registry.js";
import type {
  TrustedShipmentAdapter,
  TrustedTrackingObservation,
  TrustedTrackingSnapshot,
} from "../integrations/trusted-shipment-adapter.js";
import { appendAudit } from "./audit.js";
import { DomainError } from "./errors.js";
import type { ImportedShipmentEvent } from "./imported-shipment-event.js";
import {
  integrationCredentialsUnavailable,
  integrationDisabled,
  integrationNeedsReauth,
  IntegrationError,
  trackingNotFound,
} from "./integration-errors.js";
import {
  loadBoundConnection,
  recordShipmentSyncState,
  type IntegrationConnectionRow,
} from "./integration-connections.js";
import {
  importShipmentObservations,
  type ImportShipmentObservationsResult,
  type ShipmentEventView,
} from "./shipment-events.js";
import { loadTransactionBundle } from "./transactions.js";

export interface TrustedShipmentSyncResult {
  transactionId: string;
  proofId: string;
  connectionId: string;
  adapterKey: string;
  provider: string;
  createdCount: number;
  eventCount: number;
  events: ShipmentEventView[];
  replayed: boolean;
}

export async function executeTrustedShipmentSync(
  db: Database,
  clock: Clock,
  actorUserId: string,
  transactionId: string,
  deps: {
    integrations: IntegrationAdapterRegistry;
    credentials: IntegrationCredentialStore;
  },
): Promise<TrustedShipmentSyncResult> {
  const started = Date.now();
  const bundle = await loadTransactionBundle(db, transactionId);
  if (!bundle) {
    throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  }
  await assertParticipantCanSync(db, actorUserId, bundle.proofId, bundle.txn.created_by);
  const connection = await loadBoundConnection(db, transactionId);
  assertConnectionRunnable(connection);
  const adapter = deps.integrations.getTrustedShipment(connection.adapter_key);
  const credentials = await deps.credentials.getCredentials({
    adapterKey: adapter.adapterKey,
    credentialReference: connection.credential_reference,
    connectionId: connection.id,
  });
  if (!credentials) {
    await recordShipmentSyncState(db, clock, {
      transactionId,
      connectionId: connection.id,
      succeeded: false,
      errorCode: "INTEGRATION_CREDENTIALS_UNAVAILABLE",
      retryable: true,
    });
    throw integrationCredentialsUnavailable();
  }
  const trackingNumber = bundle.shipping?.tracking_number?.trim() ?? "";
  if (!trackingNumber) {
    throw trackingNotFound();
  }

  let snapshot: TrustedTrackingSnapshot;
  try {
    snapshot = await adapter.getTrackingSnapshot({
      trackingNumber,
      transactionId,
      externalTransactionId: bundle.txn.external_reference,
      credentials,
    });
  } catch (error) {
    await recordFailure(db, clock, transactionId, connection.id, error);
    logIntegrationEvent({
      adapterKey: adapter.adapterKey,
      connectionId: connection.id,
      transactionId,
      proofId: bundle.proofId ?? undefined,
      outcome: errorCode(error),
      durationMs: Date.now() - started,
    });
    throw error;
  }

  const observations = toTrustedImportedEvents(adapter, snapshot);
  const imported = await importShipmentObservations(
    db,
    clock,
    connection.owner_user_id,
    transactionId,
    observations,
  );
  await recordShipmentSyncState(db, clock, {
    transactionId,
    connectionId: connection.id,
    succeeded: true,
  });
  if (imported.createdCount > 0 && imported.proofId) {
    await appendAudit(db, {
      proofId: imported.proofId,
      actorUserId,
      eventType: "SHIPMENT_SYNC_COMPLETED",
      eventData: {
        connectionId: connection.id,
        adapterKey: adapter.adapterKey,
        provider: adapter.provider,
        createdCount: imported.createdCount,
        eventCount: imported.events.length,
      },
      at: clock.now(),
    });
  }
  logIntegrationEvent({
    adapterKey: adapter.adapterKey,
    connectionId: connection.id,
    transactionId,
    proofId: imported.proofId,
    outcome: "SYNC_COMPLETED",
    observationCount: imported.createdCount,
    durationMs: Date.now() - started,
  });
  return toSyncResult(connection, adapter, imported, false);
}

export function toTrustedImportedEvents(
  adapter: TrustedShipmentAdapter,
  snapshot: TrustedTrackingSnapshot,
): ImportedShipmentEvent[] {
  return snapshot.observations.map((observation) =>
    observationToImported(adapter, snapshot.carrier, observation),
  );
}

export function observationToImported(
  adapter: TrustedShipmentAdapter,
  carrier: string | null,
  observation: TrustedTrackingObservation,
): ImportedShipmentEvent {
  return {
    eventType: observation.eventType ?? observation.carrierStatus ?? "CARRIER_EVENT",
    occurredAt: observation.occurredAt,
    carrier,
    locationText: observation.location ?? null,
    source: "SHIPPING_PROVIDER_API",
    provider: adapter.provider,
    sourceEventId: observation.sourceEventId ?? null,
    eventData: stripProvenanceKeys(observation.eventData ?? {}),
    payloadSha256: null,
  };
}

export function assertConnectionRunnable(connection: IntegrationConnectionRow): void {
  if (connection.status === "DISABLED") {
    throw integrationDisabled();
  }
  if (connection.status === "NEEDS_REAUTH") {
    throw integrationNeedsReauth();
  }
  if (connection.status !== "ACTIVE") {
    throw integrationDisabled();
  }
}

async function assertParticipantCanSync(
  db: Database,
  actorUserId: string,
  proofId: string | null,
  sellerUserId: string,
): Promise<void> {
  if (actorUserId === sellerUserId) {
    return;
  }
  if (!proofId) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Not allowed to sync shipment observations on this transaction",
      403,
    );
  }
  const participant = await db.query<{ id: string }>(
    `SELECT id FROM proof_participants WHERE proof_id = $1 AND user_id = $2`,
    [proofId, actorUserId],
  );
  if (!participant.rows[0]) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Not allowed to sync shipment observations on this transaction",
      403,
    );
  }
}

async function recordFailure(
  db: Database,
  clock: Clock,
  transactionId: string,
  connectionId: string,
  error: unknown,
): Promise<void> {
  await recordShipmentSyncState(db, clock, {
    transactionId,
    connectionId,
    succeeded: false,
    errorCode: errorCode(error),
    retryable: error instanceof IntegrationError ? error.retryable : false,
  });
}

function errorCode(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }
  return "PROVIDER_TEMPORARILY_UNAVAILABLE";
}

function stripProvenanceKeys(data: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...data };
  delete copy.source;
  delete copy.provider;
  return copy;
}

function toSyncResult(
  connection: IntegrationConnectionRow,
  adapter: TrustedShipmentAdapter,
  imported: ImportShipmentObservationsResult,
  replayed: boolean,
): TrustedShipmentSyncResult {
  return {
    transactionId: imported.transactionId,
    proofId: imported.proofId,
    connectionId: connection.id,
    adapterKey: adapter.adapterKey,
    provider: adapter.provider,
    createdCount: imported.createdCount,
    eventCount: imported.events.length,
    events: imported.events,
    replayed,
  };
}
