import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { IntegrationAdapterRegistry } from "../integrations/registry.js";
import type { IntegrationCredentialStore } from "../integrations/credentials.js";
import { DomainError } from "./errors.js";
import { IntegrationError, integrationDisabled, integrationNeedsReauth } from "./integration-errors.js";
import {
  bindCommerceOrderTransaction,
  recordCommerceSyncState,
  upsertCommerceOrderRecord,
} from "./commerce-order-records.js";
import { loadConnection } from "./integration-connections.js";
import {
  eligibilityOf,
  fulfillmentOrderFingerprint,
  fulfillmentOrderToImportedTransaction,
  parseNormalizedFulfillmentOrder,
} from "./normalized-fulfillment-order.js";
import { tenantKeyForImport } from "./provenance.js";
import { importNormalizedTransaction } from "./transaction-import.js";

export interface CommerceFulfillmentSyncResult {
  connectionId: string;
  adapterKey: string;
  provider: string;
  discoveredCount: number;
  eligibleCount: number;
  createdTransactionCount: number;
  createdProofCount: number;
  existingProofCount: number;
  ineligibleCount: number;
  cursor: string | null;
}

export async function executeCommerceFulfillmentSync(
  db: Database,
  clock: Clock,
  actorUserId: string,
  connectionId: string,
  deps: {
    integrations: IntegrationAdapterRegistry;
    credentials: IntegrationCredentialStore;
  },
): Promise<CommerceFulfillmentSyncResult> {
  const connection = await loadConnection(db, connectionId);
  if (connection.owner_user_id !== actorUserId) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Not allowed to sync this commerce connection",
      403,
    );
  }
  if (connection.status === "DISABLED") {
    throw integrationDisabled();
  }
  if (connection.status === "NEEDS_REAUTH") {
    throw integrationNeedsReauth();
  }

  const adapter = deps.integrations.getCommerce(connection.adapter_key);
  let credentials = null;
  if (adapter.kind === "trusted") {
    credentials = await deps.credentials.getCredentials({
      adapterKey: adapter.adapterKey,
      credentialReference: connection.credential_reference,
      connectionId: connection.id,
    });
    if (!credentials) {
      throw new IntegrationError(
        "INTEGRATION_CREDENTIALS_UNAVAILABLE",
        "Commerce integration credentials are unavailable",
        503,
        true,
      );
    }
  }

  try {
    const page = await adapter.listFulfillmentOrders({
      connection,
      credentials,
      cursor: null,
    });
    let createdTransactionCount = 0;
    let createdProofCount = 0;
    let existingProofCount = 0;
    let eligibleCount = 0;

    for (const raw of page.orders) {
      const order = parseNormalizedFulfillmentOrder(raw);
      const eligibility = eligibilityOf(order);
      const fingerprint = fulfillmentOrderFingerprint(order);
      const tenantKey = tenantKeyForImport(
        order.provider,
        order.provenance.source,
        order.externalAccountReference,
      );
      const record = await upsertCommerceOrderRecord(db, clock, {
        connectionId: connection.id,
        commerceTenantKey: tenantKey,
        externalOrderId: order.externalOrderId,
        externalReference: order.externalReference,
        orderedAt: order.orderedAt,
        paymentState: order.paymentState,
        fulfillmentState: order.fulfillmentState,
        requiresPhysicalFulfillment: order.requiresPhysicalFulfillment,
        cancelled: order.cancelled,
        eligibility,
        providerUpdatedAt: order.providerUpdatedAt,
        fingerprint,
      });

      if (eligibility !== "FULFILLMENT_ELIGIBLE") {
        continue;
      }
      eligibleCount += 1;
      const imported = fulfillmentOrderToImportedTransaction(order, clock.now().toISOString());
      const result = await importNormalizedTransaction(db, clock, actorUserId, imported, {
        adapterKey: adapter.adapterKey,
        createProof: true,
        participationPolicy: "COUNTERPARTY_OPTIONAL",
      });
      await bindCommerceOrderTransaction(db, record.id, result.transaction.transactionId);
      if (result.created) {
        createdTransactionCount += 1;
      }
      if (result.proofCreated) {
        createdProofCount += 1;
      } else if (result.proof) {
        existingProofCount += 1;
      }
    }

    await recordCommerceSyncState(db, clock, {
      connectionId: connection.id,
      succeeded: true,
      providerCursor: page.cursor,
    });

    return {
      connectionId: connection.id,
      adapterKey: adapter.adapterKey,
      provider: adapter.provider,
      discoveredCount: page.orders.length,
      eligibleCount,
      createdTransactionCount,
      createdProofCount,
      existingProofCount,
      ineligibleCount: page.orders.length - eligibleCount,
      cursor: page.cursor,
    };
  } catch (error) {
    const code =
      error instanceof IntegrationError || error instanceof DomainError
        ? error.code
        : "PROVIDER_TEMPORARILY_UNAVAILABLE";
    const retryable = error instanceof IntegrationError ? error.retryable : true;
    await recordCommerceSyncState(db, clock, {
      connectionId: connection.id,
      succeeded: false,
      errorCode: code,
      retryable,
    });
    throw error;
  }
}
