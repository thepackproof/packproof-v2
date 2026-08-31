import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import type { IntegrationCredentialStore } from "../integrations/credentials.js";
import { logIntegrationEvent } from "../integrations/log.js";
import type { IntegrationAdapterRegistry } from "../integrations/registry.js";
import type { VerifiedWebhookResult } from "../integrations/trusted-shipment-adapter.js";
import { appendAudit } from "./audit.js";
import { isUniqueViolation } from "./errors.js";
import {
  IntegrationError,
  trackingNotFound,
  webhookSignatureInvalid,
} from "./integration-errors.js";
import type { IntegrationConnectionRow } from "./integration-connections.js";
import {
  findBoundConnectionByTracking,
  listActiveConnectionsForAdapter,
  recordShipmentSyncState,
} from "./integration-connections.js";
import {
  importShipmentObservations,
} from "./shipment-events.js";
import {
  assertConnectionRunnable,
  observationToImported,
  type TrustedShipmentSyncResult,
} from "./trusted-shipment-sync.js";

export async function ingestTrustedShipmentWebhook(
  db: Database,
  clock: Clock,
  adapterKey: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  deps: {
    integrations: IntegrationAdapterRegistry;
    credentials: IntegrationCredentialStore;
  },
): Promise<TrustedShipmentSyncResult> {
  const started = Date.now();
  const adapter = deps.integrations.getTrustedShipment(adapterKey);
  const connections = await listActiveConnectionsForAdapter(db, adapter.adapterKey);
  if (connections.length === 0) {
    throw trackingNotFound();
  }

  let verified: VerifiedWebhookResult | null = null;
  let bound: IntegrationConnectionRow | null = null;
  let transactionId: string | null = null;
  let lastError: unknown = webhookSignatureInvalid();
  for (const candidate of connections) {
    const credentials = await deps.credentials.getCredentials({
      adapterKey: adapter.adapterKey,
      credentialReference: candidate.credential_reference,
      connectionId: candidate.id,
    });
    if (!credentials) {
      continue;
    }
    try {
      const result = await adapter.verifyWebhook({ headers, rawBody, credentials });
      const trackingNumber = result.trackingNumber?.trim() ?? "";
      if (!trackingNumber) {
        if (result.observations.length === 0 && result.providerEventId) {
          const replayed = await insertWebhookReceipt(db, clock, {
            adapterKey: adapter.adapterKey,
            providerEventId: result.providerEventId,
            signatureSha256: sha256Hex(rawBody),
          });
          logIntegrationEvent({
            adapterKey: adapter.adapterKey,
            connectionId: candidate.id,
            outcome: "WEBHOOK_IGNORED",
            durationMs: Date.now() - started,
          });
          return {
            transactionId: "",
            proofId: "",
            connectionId: candidate.id,
            adapterKey: adapter.adapterKey,
            provider: adapter.provider,
            createdCount: 0,
            eventCount: 0,
            events: [],
            replayed,
          };
        }
        lastError = trackingNotFound();
        continue;
      }
      const matched = await findBoundConnectionByTracking(db, adapter.adapterKey, trackingNumber);
      if (!matched || matched.connection.id !== candidate.id) {
        lastError = trackingNotFound();
        continue;
      }
      verified = result;
      bound = matched.connection;
      transactionId = matched.transactionId;
      lastError = null;
      break;
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "WEBHOOK_REPLAY_REJECTED") {
        throw error;
      }
      lastError = error;
    }
  }
  if (!verified || !bound || !transactionId) {
    throw lastError instanceof Error ? lastError : webhookSignatureInvalid();
  }
  assertConnectionRunnable(bound);

  const imported = await importShipmentObservations(
    db,
    clock,
    bound.owner_user_id,
    transactionId,
    verified.observations.map((observation) =>
      observationToImported(adapter, verified.carrier ?? null, observation),
    ),
  );
  const replayed = await insertWebhookReceipt(db, clock, {
    adapterKey: adapter.adapterKey,
    providerEventId: verified.providerEventId,
    signatureSha256: sha256Hex(rawBody),
  });
  await recordShipmentSyncState(db, clock, {
    transactionId,
    connectionId: bound.id,
    succeeded: true,
  });
  if (imported.createdCount > 0 && imported.proofId) {
    await appendAudit(db, {
      proofId: imported.proofId,
      actorUserId: bound.owner_user_id,
      eventType: "TRUSTED_SHIPMENT_EVENTS_IMPORTED",
      eventData: {
        connectionId: bound.id,
        adapterKey: adapter.adapterKey,
        provider: adapter.provider,
        createdCount: imported.createdCount,
      },
      at: clock.now(),
    });
  }
  logIntegrationEvent({
    adapterKey: adapter.adapterKey,
    connectionId: bound.id,
    transactionId,
    proofId: imported.proofId,
    outcome: replayed && imported.createdCount === 0 ? "WEBHOOK_REPLAY_IDEMPOTENT" : "WEBHOOK_IMPORTED",
    observationCount: imported.createdCount,
    durationMs: Date.now() - started,
  });
  return {
    transactionId: imported.transactionId,
    proofId: imported.proofId,
    connectionId: bound.id,
    adapterKey: adapter.adapterKey,
    provider: adapter.provider,
    createdCount: imported.createdCount,
    eventCount: imported.events.length,
    events: imported.events,
    replayed: replayed && imported.createdCount === 0,
  };
}

async function insertWebhookReceipt(
  db: Database,
  clock: Clock,
  input: { adapterKey: string; providerEventId: string; signatureSha256: string },
): Promise<boolean> {
  try {
    await db.query(
      `INSERT INTO integration_webhook_receipts (
         id, adapter_key, provider_event_id, signature_sha256, received_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        newId("whr"),
        input.adapterKey,
        input.providerEventId,
        input.signatureSha256,
        clock.now().toISOString(),
      ],
    );
    return false;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return true;
    }
    throw error;
  }
}
