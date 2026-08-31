import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit, listAuditEvents } from "./audit.js";
import { bindProofExternalReference, normalizeTenantKey } from "./external-references.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import type { ProvenanceSource } from "./provenance.js";
import { shippingWriteHasValues, toShippingView } from "./transaction-fields.js";
import type { ShippingRow, TransactionIntegrationIdentityRow } from "./types.js";

export { normalizeTenantKey };

export async function findTransactionIdentity(
  db: Database,
  tenantKey: string,
  externalTransactionId: string,
): Promise<TransactionIntegrationIdentityRow | null> {
  const tenant = normalizeTenantKey(tenantKey);
  const found = await db.query<TransactionIntegrationIdentityRow>(
    `SELECT * FROM transaction_integration_identities
      WHERE tenant_key = $1 AND external_transaction_id = $2`,
    [tenant, externalTransactionId],
  );
  return found.rows[0] ?? null;
}

export async function listTransactionIdentities(
  db: Database,
  transactionId: string,
): Promise<TransactionIntegrationIdentityRow[]> {
  const found = await db.query<TransactionIntegrationIdentityRow>(
    `SELECT * FROM transaction_integration_identities
      WHERE transaction_id = $1
      ORDER BY created_at ASC, id ASC`,
    [transactionId],
  );
  return found.rows;
}

export async function insertTransactionIdentity(
  db: Database,
  input: {
    transactionId: string;
    tenantKey: string;
    externalTransactionId: string;
    adapterKey: string;
    source: ProvenanceSource;
    at: Date;
  },
): Promise<TransactionIntegrationIdentityRow> {
  const tenantKey = normalizeTenantKey(input.tenantKey);
  const id = newId("iid");
  try {
    await db.query(
      `INSERT INTO transaction_integration_identities (
         id, transaction_id, tenant_key, external_transaction_id, adapter_key, source, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.transactionId,
        tenantKey,
        input.externalTransactionId,
        input.adapterKey,
        input.source,
        input.at.toISOString(),
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await findTransactionIdentity(
        db,
        tenantKey,
        input.externalTransactionId,
      );
      if (existing?.transaction_id === input.transactionId) {
        return existing;
      }
      if (existing) {
        throw new DomainError(
          "INTEGRATION_IDENTITY_CONFLICT",
          "External transaction identity is already bound to another transaction",
          409,
        );
      }
      throw new DomainError(
        "INTEGRATION_IDENTITY_CONFLICT",
        "This transaction already has an identity for this tenant",
        409,
      );
    }
    throw error;
  }
  const inserted = await db.query<TransactionIntegrationIdentityRow>(
    `SELECT * FROM transaction_integration_identities WHERE id = $1`,
    [id],
  );
  return inserted.rows[0];
}

export async function ensureIntegrationExternalReferences(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  transactionId: string,
): Promise<void> {
  const identities = await listTransactionIdentities(db, transactionId);
  for (const identity of identities) {
    await bindProofExternalReference(db, clock, actorUserId, {
      proofId,
      tenantKey: identity.tenant_key,
      externalTransactionId: identity.external_transaction_id,
      source: "INTEGRATION",
    });
  }
}

export async function ensureImportAuditEvents(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  transactionId: string,
): Promise<void> {
  const identities = await listTransactionIdentities(db, transactionId);
  if (identities.length === 0) {
    return;
  }
  const events = await listAuditEvents(db, proofId);
  const types = new Set(events.map((event) => event.eventType));
  const now = clock.now();
  const identity = identities[0];
  if (!types.has("TRANSACTION_IMPORTED")) {
    await appendAudit(db, {
      proofId,
      actorUserId,
      eventType: "TRANSACTION_IMPORTED",
      eventData: {
        transactionId,
        tenantKey: identity.tenant_key,
        externalTransactionId: identity.external_transaction_id,
        source: identity.source,
        adapterKey: identity.adapter_key,
      },
      at: now,
    });
  }
  const shipping = await db.query<ShippingRow>(
    `SELECT * FROM transaction_shipping WHERE transaction_id = $1`,
    [transactionId],
  );
  const shippingView = toShippingView(shipping.rows[0]);
  const hasShipping =
    shippingView != null &&
    shippingWriteHasValues({
      carrier: shippingView.carrier,
      service: shippingView.service,
      trackingNumber: shippingView.trackingNumber,
      shipmentDate: shippingView.shipmentDate,
    });
  if (hasShipping && !types.has("SHIPPING_DETAILS_IMPORTED")) {
    await appendAudit(db, {
      proofId,
      actorUserId,
      eventType: "SHIPPING_DETAILS_IMPORTED",
      eventData: {
        transactionId,
        tenantKey: identity.tenant_key,
        externalTransactionId: identity.external_transaction_id,
        source: identity.source,
      },
      at: now,
    });
  }
}
