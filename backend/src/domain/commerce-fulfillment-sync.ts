import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { IntegrationAdapterRegistry } from "../integrations/registry.js";
import type { IntegrationCredentialStore } from "../integrations/credentials.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { IntegrationError, integrationDisabled, integrationNeedsReauth } from "./integration-errors.js";
import { bindCommerceOrderTransaction, upsertCommerceOrderRecord, type CommerceSyncStateRow } from "./commerce-order-records.js";
import { loadConnection, updateConnectionStatus } from "./integration-connections.js";
import { findTransactionIdentity, insertTransactionIdentity } from "./integration-identities.js";
import { commerceIdentityAccount, eligibilityOf, fulfillmentOrderFingerprint, fulfillmentOrderToImportedTransaction, parseNormalizedFulfillmentOrder } from "./normalized-fulfillment-order.js";
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
    complete: boolean;
    staleCount: number;
    supplementCount: number;
}
export interface CommerceSyncDependencies {
    integrations: IntegrationAdapterRegistry;
    credentials: IntegrationCredentialStore;
}
export const MAX_COMMERCE_SYNC_PAGES = 20;
const LEASE_MS = 120000;
/** Page checkpoints survive crashes; a fencing token prevents expired workers committing work. */
export async function executeCommerceFulfillmentSync(db: Database, clock: Clock, actorUserId: string, connectionId: string, deps: CommerceSyncDependencies, options: {
    maxPages?: number;
    background?: boolean;
} = {}): Promise<CommerceFulfillmentSyncResult> {
    const connection = await loadConnection(db, connectionId);
    if (connection.owner_user_id !== actorUserId)
        throw new DomainError("PARTICIPANT_NOT_AUTHORIZED", "Not allowed to sync this commerce connection", 403);
    if (connection.status === "DISABLED")
        throw integrationDisabled();
    if (connection.status === "NEEDS_REAUTH")
        throw integrationNeedsReauth();
    if (options.background && !connection.auto_sync_enabled)
        throw integrationDisabled();
    const adapter = deps.integrations.getCommerce(connection.adapter_key);
    const leaseToken = newId("sync");
    const started = clock.now();
    const state = await db.transaction(async (tx) => {
        await tx.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at) VALUES($1,$2)
      ON CONFLICT(connection_id) DO NOTHING`, [connectionId, started.toISOString()]);
        const current = (await tx.query<CommerceSyncStateRow>(`SELECT * FROM commerce_connection_sync_states WHERE connection_id=$1 FOR UPDATE`, [connectionId])).rows[0];
        if (current.lease_expires_at && new Date(current.lease_expires_at).getTime() > started.getTime())
            throw new DomainError("COMMERCE_SYNC_IN_PROGRESS", "Orders are already syncing", 409);
        const fullReconciliation = current.window_started_at ? current.reconciliation_pass :
            !current.last_reconciled_at || started.getTime() - new Date(current.last_reconciled_at).getTime() >= 15 * 60000;
        const windowStart = current.window_started_at ?? new Date(fullReconciliation ? started.getTime() - 60 * 86400000 :
            new Date(current.last_succeeded_at ?? started).getTime() - 15 * 60000).toISOString();
        const windowEnd = current.window_ended_at ?? started.toISOString();
        await tx.query(`UPDATE commerce_connection_sync_states SET run_status='RUNNING',lease_token=$2,
      lease_expires_at=$3,last_attempted_at=$4,updated_at=$4,window_started_at=$5,window_ended_at=$6
      ,reconciliation_pass=$7,discovered_count=CASE WHEN provider_cursor IS NULL THEN 0 ELSE discovered_count END,
      eligible_count=CASE WHEN provider_cursor IS NULL THEN 0 ELSE eligible_count END
      WHERE connection_id=$1`, [connectionId, leaseToken, new Date(started.getTime() + LEASE_MS).toISOString(), started.toISOString(), windowStart, windowEnd, fullReconciliation]);
        return { ...current, window_started_at: windowStart, window_ended_at: windowEnd };
    });
    const result: CommerceFulfillmentSyncResult = { connectionId, adapterKey: adapter.adapterKey, provider: adapter.provider,
        discoveredCount: 0, eligibleCount: 0, createdTransactionCount: 0, createdProofCount: 0, existingProofCount: 0,
        ineligibleCount: 0, cursor: state.provider_cursor, complete: false, staleCount: 0, supplementCount: 0 };
    const seenCursors = new Set<string>();
    if (result.cursor)
        seenCursors.add(result.cursor);
    try {
        for (let pageNo = 0; pageNo < Math.min(Math.max(options.maxPages ?? MAX_COMMERCE_SYNC_PAGES, 1), 100); pageNo++) {
            const credentials = adapter.kind === "trusted" ? await deps.credentials.getCredentials({ adapterKey: adapter.adapterKey, credentialReference: connection.credential_reference, connectionId }) : null;
            if (adapter.kind === "trusted" && !credentials)
                throw new IntegrationError("INTEGRATION_CREDENTIALS_UNAVAILABLE", "Commerce credentials are unavailable", 503, true);
            const page = await adapter.listFulfillmentOrders({ connection, credentials, cursor: result.cursor,
                updatedSince: new Date(state.window_started_at!).toISOString(), updatedUntil: new Date(state.window_ended_at!).toISOString(),
                onProgress: () => db.transaction(tx => requireLease(tx, clock, connectionId, leaseToken, options.background === true)) });
            if (page.cursor && seenCursors.has(page.cursor))
                throw new IntegrationError("PROVIDER_CURSOR_INVALID", "Provider repeated a page cursor", 502, false);
            for (const raw of page.orders) {
                const order = parseNormalizedFulfillmentOrder(raw);
                if (order.provider !== adapter.provider || order.externalAccountReference !== connection.external_account_reference)
                    throw new DomainError("INTEGRATION_TRUST_BOUNDARY", "Order belongs to another provider or store", 403);
                const eligibility = eligibilityOf(order), fingerprint = fulfillmentOrderFingerprint(order);
                const counts = await db.transaction(async (tx) => {
                    await requireLease(tx, clock, connectionId, leaseToken, options.background === true);
                    const record = await upsertCommerceOrderRecord(tx, clock, { connectionId, commerceTenantKey: tenantKeyForImport(order.provider, order.provenance.source, commerceIdentityAccount(order)),
                        externalOrderId: order.externalOrderId, externalReference: order.externalReference, orderedAt: order.orderedAt, paymentState: order.paymentState,
                        fulfillmentState: order.fulfillmentState, requiresPhysicalFulfillment: order.requiresPhysicalFulfillment, cancelled: order.cancelled,
                        eligibility, providerUpdatedAt: order.providerUpdatedAt, fingerprint });
                    const stale = record.normalized_fingerprint !== fingerprint;
                    if (!record.transaction_id) {
                        const tenantKey = tenantKeyForImport(order.provider, order.provenance.source, commerceIdentityAccount(order));
                        let identity = await findTransactionIdentity(tx, tenantKey, order.externalOrderId);
                        // Add a scoped alias for pre-automation eBay imports. Never rewrite their old identity or manifest.
                        if (!identity && order.provider === "ebay" && order.providerEnvironment) {
                            const legacy = await findTransactionIdentity(tx, tenantKeyForImport("ebay", "MARKETPLACE_API", order.providerEnvironment), order.externalOrderId);
                            if (legacy) {
                                const owned = await tx.query("SELECT id FROM transactions WHERE id=$1 AND created_by=$2", [legacy.transaction_id, actorUserId]);
                                if (owned.rows[0])
                                    identity = await insertTransactionIdentity(tx, { transactionId: legacy.transaction_id, tenantKey, externalTransactionId: order.externalOrderId, adapterKey: adapter.adapterKey, source: order.provenance.source, at: clock.now() });
                            }
                        }
                        if (identity) {
                            const owned = await tx.query("SELECT id FROM transactions WHERE id=$1 AND created_by=$2", [identity.transaction_id, actorUserId]);
                            if (!owned.rows[0])
                                throw new DomainError("INTEGRATION_IDENTITY_CONFLICT", "Imported order belongs to another seller", 409);
                            await bindCommerceOrderTransaction(tx, record.id, identity.transaction_id);
                            record.transaction_id = identity.transaction_id;
                        }
                    }
                    const proof = record.transaction_id ? (await tx.query<{
                        id: string;
                        status: string;
                    }>("SELECT id,status FROM proofs WHERE transaction_id=$1", [record.transaction_id])).rows[0] : null;
                    await tx.query(`INSERT INTO commerce_order_revisions(id,order_record_id,connection_id,fingerprint,provider_updated_at,observed_at,mapping_version,disposition,normalized_order)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(order_record_id,fingerprint) DO NOTHING`, [newId("rev"), record.id, connectionId, fingerprint, order.providerUpdatedAt, clock.now().toISOString(), "packproof.commerce-normalization.v2", stale ? "STALE" : proof?.status === "FINALIZED" ? "SUPPLEMENT" : "APPLIED", JSON.stringify(order)]);
                    if (stale)
                        return { stale: 1 };
                    if (proof?.status === "FINALIZED")
                        return { supplement: 1, existing: 1 };
                    // Cancellation/fulfillment changes update operational eligibility even when no Proof is created.
                    if (eligibility !== "FULFILLMENT_ELIGIBLE")
                        return {};
                    const imported = await importNormalizedTransaction(tx, clock, actorUserId, fulfillmentOrderToImportedTransaction(order, clock.now().toISOString()), { adapterKey: adapter.adapterKey, createProof: true, participationPolicy: "COUNTERPARTY_OPTIONAL" });
                    await bindCommerceOrderTransaction(tx, record.id, imported.transaction.transactionId);
                    return { createdTransaction: imported.created ? 1 : 0, createdProof: imported.proofCreated ? 1 : 0, existing: imported.proof && !imported.proofCreated ? 1 : 0 };
                });
                result.discoveredCount++;
                result.eligibleCount += eligibility === "FULFILLMENT_ELIGIBLE" ? 1 : 0;
                result.staleCount += counts.stale ?? 0;
                result.supplementCount += counts.supplement ?? 0;
                result.createdTransactionCount += counts.createdTransaction ?? 0;
                result.createdProofCount += counts.createdProof ?? 0;
                result.existingProofCount += counts.existing ?? 0;
            }
            result.cursor = page.cursor;
            result.complete = page.cursor === null;
            if (page.cursor)
                seenCursors.add(page.cursor);
            await db.transaction(async (tx) => {
                await requireLease(tx, clock, connectionId, leaseToken, options.background === true);
                await tx.query(`UPDATE commerce_connection_sync_states SET provider_cursor=$3,lease_expires_at=$4,
          discovered_count=discovered_count+$5,eligible_count=eligible_count+$6,updated_at=$7 WHERE connection_id=$1 AND lease_token=$2`, [connectionId, leaseToken, page.cursor, new Date(clock.now().getTime() + LEASE_MS).toISOString(), page.orders.length, page.orders.filter(o => eligibilityOf(o) === "FULFILLMENT_ELIGIBLE").length, clock.now().toISOString()]);
            });
            if (result.complete)
                break;
        }
        const now = clock.now().toISOString();
        await db.query(`UPDATE commerce_connection_sync_states SET run_status='IDLE',lease_token=NULL,lease_expires_at=NULL,
      last_succeeded_at=CASE WHEN $3 THEN $4::timestamptz ELSE last_succeeded_at END,
      initial_sync_completed_at=CASE WHEN $3 THEN COALESCE(initial_sync_completed_at,$4::timestamptz) ELSE initial_sync_completed_at END,
      window_started_at=CASE WHEN $3 THEN NULL ELSE window_started_at END,
      window_ended_at=CASE WHEN $3 THEN NULL ELSE window_ended_at END,
      last_reconciled_at=CASE WHEN $3 AND reconciliation_pass THEN $4::timestamptz ELSE last_reconciled_at END,
      next_run_at=$5,last_error_code=NULL,last_error_retryable=NULL,attempt_count=0,updated_at=$4
      WHERE connection_id=$1 AND lease_token=$2`, [connectionId, leaseToken, result.complete, now, new Date(clock.now().getTime() + (result.complete ? 60000 : 0)).toISOString()]);
        // Incremental reads overlap 15 minutes; a bounded 60-day reconciliation runs every 15 minutes.
        if (result.complete)
            await db.query("UPDATE commerce_webhook_inbox SET processed_at=$2 WHERE connection_id=$1 AND processed_at IS NULL AND received_at<=$3", [connectionId, now, started.toISOString()]);
        result.ineligibleCount = result.discoveredCount - result.eligibleCount;
        return result;
    }
    catch (error) {
        const code = error instanceof IntegrationError || error instanceof DomainError ? error.code : "PROVIDER_TEMPORARILY_UNAVAILABLE";
        const authFailure = code === "INTEGRATION_NEEDS_REAUTH" || code === "CONNECTED_ACCOUNT_REAUTH_REQUIRED" || code === "PROVIDER_AUTH_FAILED";
        const retryable = authFailure ? false : error instanceof IntegrationError ? error.retryable : !(error instanceof DomainError && error.httpStatus < 500);
        const attempt = (state.attempt_count ?? 0) + 1;
        if (authFailure)
            await updateConnectionStatus(db, clock, connectionId, "NEEDS_REAUTH");
        await db.query(`UPDATE commerce_connection_sync_states SET run_status=$3,lease_token=NULL,lease_expires_at=NULL,
      last_error_code=$4,last_error_retryable=$5,attempt_count=$6,next_run_at=$7,updated_at=$8
      WHERE connection_id=$1 AND lease_token=$2`, [connectionId, leaseToken, retryable && attempt < 8 ? "RETRYING" : "FAILED", code, retryable, attempt,
            new Date(clock.now().getTime() + Math.min(30000 * 2 ** Math.min(attempt - 1, 6), 900000)).toISOString(), clock.now().toISOString()]);
        throw error;
    }
}
async function requireLease(db: Database, clock: Clock, connectionId: string, token: string, background: boolean) {
    const found = await db.query(`SELECT s.connection_id FROM commerce_connection_sync_states s JOIN integration_connections c ON c.id=s.connection_id
    WHERE s.connection_id=$1 AND s.lease_token=$2 AND s.lease_expires_at>$3 AND c.status='ACTIVE'
    AND ($4=false OR c.auto_sync_enabled=true) FOR UPDATE OF s,c`, [connectionId, token, clock.now().toISOString(), background]);
    if (!found.rows[0])
        throw new DomainError("COMMERCE_SYNC_LEASE_LOST", "This sync was superseded or paused", 409);
    await db.query("UPDATE commerce_connection_sync_states SET lease_expires_at=$3 WHERE connection_id=$1 AND lease_token=$2",[connectionId,token,new Date(clock.now().getTime()+LEASE_MS).toISOString()]);
}
