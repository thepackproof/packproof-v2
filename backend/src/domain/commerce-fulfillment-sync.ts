import { sha256Hex } from "../hash.js";
import { isEbaySubjectSuppressed, lockEbayPrivacy } from "./ebay-deletion-cases.js";
import { indexIdentifierItems } from '../identifiers/catalog.js';
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { IntegrationAdapterRegistry } from "../integrations/registry.js";
import type { IntegrationCredentialStore } from "../integrations/credentials.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { IntegrationError, integrationDisabled, integrationNeedsReauth } from "./integration-errors.js";
import { bindCommerceOrderTransaction, upsertCommerceOrderRecord, type CommerceSyncStateRow } from "./commerce-order-records.js";
import type { IntegrationConnectionRow } from "./integration-connections.js";
import type { CommerceFulfillmentAdapter } from "../integrations/commerce-fulfillment-adapter.js";
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
    /** Undefined retains existing deployments; an explicit list independently gates provider automation. */
    automationProviders?: readonly string[];
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
    if (options.background && (!connection.auto_sync_enabled || (deps.automationProviders && !deps.automationProviders.includes(connection.provider))))
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
        if (!current.window_started_at) await tx.query("DELETE FROM commerce_sync_page_checkpoints WHERE connection_id=$1", [connectionId]);
        // Fulfillment routing/hold events need not change the order updatedAt.
        // An invalidation therefore requires a complete accessible-order pass,
        // not just the ordinary recent-update overlap. Retain an in-flight cursor.
        const pendingWebhook = !current.window_started_at && (await tx.query(
            "SELECT id FROM commerce_webhook_inbox WHERE connection_id=$1 AND processed_at IS NULL LIMIT 1", [connectionId])).rows.length > 0;
        const fullReconciliation = current.window_started_at ? current.reconciliation_pass :
            pendingWebhook || !current.last_reconciled_at || started.getTime() - new Date(current.last_reconciled_at).getTime() >= (adapter.reconciliationIntervalMs ?? 15 * 60000);
        const windowStart = current.window_started_at ?? new Date(fullReconciliation ? started.getTime() - 60 * 86400000 :
            new Date(current.last_succeeded_at ?? started).getTime() - 15 * 60000).toISOString();
        const windowEnd = current.window_ended_at ?? started.toISOString();
        await tx.query(`UPDATE commerce_connection_sync_states SET run_status='RUNNING',lease_token=$2,
      lease_expires_at=$3,last_attempted_at=$4,updated_at=$4,window_started_at=$5,window_ended_at=$6
      ,reconciliation_pass=$7,discovered_count=CASE WHEN provider_cursor IS NULL THEN 0 ELSE discovered_count END,
      eligible_count=CASE WHEN provider_cursor IS NULL THEN 0 ELSE eligible_count END
      WHERE connection_id=$1`, [connectionId, leaseToken, new Date(started.getTime() + LEASE_MS).toISOString(), started.toISOString(), windowStart, windowEnd, fullReconciliation]);
        return { ...current, window_started_at: windowStart, window_ended_at: windowEnd, reconciliation_pass: fullReconciliation };
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
                fullReconciliation: state.reconciliation_pass,
                onProgress: () => db.transaction(tx => requireLease(tx, clock, connectionId, leaseToken, options.background === true)) });
            if (page.cursor && (seenCursors.has(page.cursor) || (await db.query("SELECT connection_id FROM commerce_sync_page_checkpoints WHERE connection_id=$1 AND cursor_sha256=$2", [connectionId, sha256Hex(page.cursor)])).rows.length))
                throw new IntegrationError("PROVIDER_CURSOR_INVALID", "Provider repeated a page cursor", 502, false);
            for (const raw of page.orders) {
                const order = parseNormalizedFulfillmentOrder(raw);
                if (order.provider !== adapter.provider || order.externalAccountReference !== connection.external_account_reference)
                    throw new DomainError("INTEGRATION_TRUST_BOUNDARY", "Order belongs to another provider or store", 403);
                const eligibility = eligibilityOf(order);
                const counts = await applyCommerceOrder(db, clock, actorUserId, connection, adapter, order,
                    tx => requireLease(tx, clock, connectionId, leaseToken, options.background === true));
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
                if (page.cursor) await tx.query(`INSERT INTO commerce_sync_page_checkpoints(connection_id,cursor_sha256)
                  VALUES($1,$2) ON CONFLICT DO NOTHING`, [connectionId, sha256Hex(page.cursor)]);
                else await tx.query("DELETE FROM commerce_sync_page_checkpoints WHERE connection_id=$1", [connectionId]);
                await tx.query(`UPDATE commerce_connection_sync_states SET provider_cursor=$3,lease_expires_at=$4,
          discovered_count=discovered_count+$5,eligible_count=eligible_count+$6,updated_at=$7 WHERE connection_id=$1 AND lease_token=$2`, [connectionId, leaseToken, page.cursor, new Date(clock.now().getTime() + LEASE_MS).toISOString(), page.orders.length, page.orders.filter(o => eligibilityOf(o) === "FULFILLMENT_ELIGIBLE").length, clock.now().toISOString()]);
            });
            if (result.complete)
                break;
        }
        const now = clock.now().toISOString();
        await db.query(`UPDATE commerce_connection_sync_states SET run_status='IDLE',lease_token=NULL,lease_expires_at=NULL,
      last_succeeded_at=CASE WHEN $3 THEN $6::timestamptz ELSE last_succeeded_at END,
      initial_sync_completed_at=CASE WHEN $3 THEN COALESCE(initial_sync_completed_at,$4::timestamptz) ELSE initial_sync_completed_at END,
      window_started_at=CASE WHEN $3 THEN NULL ELSE window_started_at END,
      window_ended_at=CASE WHEN $3 THEN NULL ELSE window_ended_at END,
      last_reconciled_at=CASE WHEN $3 AND reconciliation_pass THEN $4::timestamptz ELSE last_reconciled_at END,
      next_run_at=$5,last_error_code=NULL,last_error_retryable=NULL,attempt_count=0,updated_at=$4
      WHERE connection_id=$1 AND lease_token=$2`, [connectionId, leaseToken, result.complete, now, new Date(clock.now().getTime() + (result.complete ? pollDelayMs(connectionId, adapter.preferredPollIntervalMs ?? 300000) : 0)).toISOString(), new Date(state.window_ended_at!).toISOString()]);
        // last_succeeded_at is the successfully covered source watermark. Using
        // wall-clock completion would skip updates during a long paginated pass;
        // updated_at and initial_sync_completed_at retain completion timing.
        // Incremental reads overlap 15 minutes; each adapter controls its bounded reconciliation cadence.
        if (result.complete && state.reconciliation_pass)
            await db.query("UPDATE commerce_webhook_inbox SET processed_at=$2 WHERE connection_id=$1 AND processed_at IS NULL AND received_at<=$3", [connectionId, now, new Date(state.window_ended_at!).toISOString()]);
        if (result.complete) {
            // Do not let completion overwrite an invalidation received during a
            // read. A retained event starts a fresh full pass on the next tick.
            await db.query(`UPDATE commerce_connection_sync_states SET next_run_at=$2
              WHERE connection_id=$1 AND EXISTS(SELECT 1 FROM commerce_webhook_inbox
                WHERE connection_id=$1 AND processed_at IS NULL)`, [connectionId, now]);
        }
        result.ineligibleCount = result.discoveredCount - result.eligibleCount;
        return result;
    }
    catch (error) {
        const code = error instanceof IntegrationError || error instanceof DomainError ? error.code : "PROVIDER_TEMPORARILY_UNAVAILABLE";
        const authFailure = code === "INTEGRATION_NEEDS_REAUTH" || code === "CONNECTED_ACCOUNT_REAUTH_REQUIRED" || code === "PROVIDER_AUTH_FAILED";
        const retryable = authFailure ? false : error instanceof IntegrationError ? error.retryable : !(error instanceof DomainError && error.httpStatus < 500);
        // Shared provider quotas are scheduling deferrals, not failed import
        // attempts. A busy application must resume automatically when capacity
        // returns instead of permanently disabling an otherwise valid shop.
        const rateDeferral = retryable && code === "PROVIDER_RATE_LIMITED";
        const providerDelay = error && typeof error === "object" && "retryAfterSeconds" in error ? Number(error.retryAfterSeconds) : 0;
        const retryDelay = Math.max(Math.min(pollDelayMs(connectionId, 30000 * 2 ** Math.min((state.attempt_count ?? 0), 6)), 900000),
            Number.isFinite(providerDelay) && providerDelay > 0 ? Math.min(providerDelay, 86400) * 1000 : 0);
        const attempt = (state.attempt_count ?? 0) + (rateDeferral ? 0 : 1);
        if (authFailure)
            await updateConnectionStatus(db, clock, connectionId, "NEEDS_REAUTH");
        await db.query(`UPDATE commerce_connection_sync_states SET run_status=$3,lease_token=NULL,lease_expires_at=NULL,
      last_error_code=$4,last_error_retryable=$5,attempt_count=$6,next_run_at=$7,updated_at=$8
      WHERE connection_id=$1 AND lease_token=$2`, [connectionId, leaseToken, retryable && (rateDeferral || attempt < 8) ? "RETRYING" : "FAILED", code, retryable, attempt,
            new Date(clock.now().getTime() + retryDelay).toISOString(), clock.now().toISOString()]);
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

/** A stable per-connection spread prevents a reconnect cohort hitting provider quotas together. */
function pollDelayMs(connectionId: string, base: number): number {
    return Math.round(base * (1 + parseInt(sha256Hex(connectionId).slice(0, 4), 16) / 65535 * 0.1));
}

interface CommerceOrderImportResult {
    transactionId: string | null;
    proofId: string | null;
    eligibility: string;
    stale?: number;
    supplement?: number;
    createdTransaction?: number;
    createdProof?: number;
    existing?: number;
}

async function applyCommerceOrder(db: Database, clock: Clock, actorUserId: string,
    connection: IntegrationConnectionRow, adapter: CommerceFulfillmentAdapter,
    order: ReturnType<typeof parseNormalizedFulfillmentOrder>, beforeCommit?: (tx: Database) => Promise<void>): Promise<CommerceOrderImportResult> {
    const connectionId = connection.id;
    if (order.provider !== adapter.provider || order.externalAccountReference !== connection.external_account_reference)
        throw new DomainError("INTEGRATION_TRUST_BOUNDARY", "Order belongs to another provider or store", 403);
    const eligibility = eligibilityOf(order), fingerprint = fulfillmentOrderFingerprint(order);
    return db.transaction(async tx => {
        if (order.provider === "ebay") {
            await lockEbayPrivacy(tx);
            if (await isEbaySubjectSuppressed(tx, order.providerEnvironment === "production" ? "production" : "sandbox", order.buyer?.externalId, order.buyer?.displayName)) return { transactionId: null, proofId: null, eligibility: "INELIGIBLE" };
        }
        await beforeCommit?.(tx);
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
        if (record.transaction_id) {
            const owner = await tx.query("SELECT id FROM transactions WHERE id=$1 AND created_by=$2", [record.transaction_id, actorUserId]);
            if (!owner.rows.length) throw new DomainError("INTEGRATION_IDENTITY_CONFLICT", "Imported order belongs to another seller", 409);
        }
        const proof = record.transaction_id ? (await tx.query<{
            id: string;
            status: string;
        }>("SELECT id,status FROM proofs WHERE transaction_id=$1", [record.transaction_id])).rows[0] : null;
        const revision = await tx.query(`INSERT INTO commerce_order_revisions(id,order_record_id,connection_id,fingerprint,provider_updated_at,observed_at,mapping_version,disposition,normalized_order)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(order_record_id,fingerprint) DO NOTHING RETURNING id`, [newId("rev"), record.id, connectionId, fingerprint, order.providerUpdatedAt, clock.now().toISOString(), "packproof.commerce-normalization.v2", stale ? "STALE" : proof?.status === "FINALIZED" ? "SUPPLEMENT" : "APPLIED", JSON.stringify(order)]);
        if (stale)
            return { eligibility: record.eligibility, stale: 1, transactionId: record.transaction_id, proofId: proof?.id ?? null };
        if (!revision.rows.length && proof) return { eligibility: record.eligibility, existing: 1, transactionId: record.transaction_id, proofId: proof.id };
        if(adapter.kind==='trusted')await indexIdentifierItems(tx,{ownerUserId:actorUserId,tenantKey:record.commerce_tenant_key,connectionId,sourceId:`commerce:${record.id}:${fingerprint}`,sourceRevision:fingerprint,orderRecordId:record.id,transactionId:record.transaction_id,observedAt:clock.now().toISOString(),items:order.items});
        if (proof?.status === "FINALIZED")
            return { eligibility: record.eligibility, supplement: 1, existing: 1, transactionId: record.transaction_id, proofId: proof.id };
        // Cancellation/fulfillment changes update operational eligibility even when no Proof is created.
        if (eligibility !== "FULFILLMENT_ELIGIBLE")
            return { eligibility: record.eligibility, transactionId: record.transaction_id, proofId: proof?.id ?? null };
        const imported = await importNormalizedTransaction(tx, clock, actorUserId, fulfillmentOrderToImportedTransaction(order, clock.now().toISOString()), { adapterKey: adapter.adapterKey, createProof: true, participationPolicy: "COUNTERPARTY_OPTIONAL" });
        await bindCommerceOrderTransaction(tx, record.id, imported.transaction.transactionId);
        await tx.query("UPDATE identifier_aliases SET transaction_id=$2 WHERE order_record_id=$1 AND transaction_id IS NULL",[record.id,imported.transaction.transactionId]);
        return { eligibility: record.eligibility, transactionId: imported.transaction.transactionId, proofId: imported.proof?.proofId ?? null, createdTransaction: imported.created ? 1 : 0, createdProof: imported.proofCreated ? 1 : 0, existing: imported.proof && !imported.proofCreated ? 1 : 0 };

    });
}

/** Exact API-authorized intake and scheduled reads converge on the same identity and operational projection. */
export async function fetchAndImportCommerceOrder(db: Database, clock: Clock, actorUserId: string,
    connectionId: string, externalOrderId: string, deps: CommerceSyncDependencies, beforeImport?: (tx: Database) => Promise<void>,
    afterImport?: (tx: Database, result: {transactionId: string | null; proofId: string | null}) => Promise<void>) {
    const connection = await loadConnection(db, connectionId);
    if (connection.owner_user_id !== actorUserId)
        throw new DomainError("PARTICIPANT_NOT_AUTHORIZED", "This connection belongs to another account", 403);
    if (connection.status === "NEEDS_REAUTH") throw integrationNeedsReauth();
    if (connection.status !== "ACTIVE") throw integrationDisabled();
    const adapter = deps.integrations.getCommerce(connection.adapter_key);
    if (adapter.kind !== "trusted" || !adapter.fetchFulfillmentOrder)
        throw new DomainError("COMMERCE_EXACT_READ_UNAVAILABLE", "Choose this order from your connected packing queue", 409);
    if (!externalOrderId || externalOrderId.length > 200)
        throw new DomainError("INVALID_ORDER_ID", "A valid order identifier is required", 400);
    try {
        const credentials = await deps.credentials.getCredentials({adapterKey: adapter.adapterKey, credentialReference: connection.credential_reference, connectionId});
        if (!credentials) throw new IntegrationError("INTEGRATION_CREDENTIALS_UNAVAILABLE", "Commerce credentials are unavailable", 503, true);
        const order = parseNormalizedFulfillmentOrder(await adapter.fetchFulfillmentOrder({connection, credentials, externalOrderId}));
        if (order.externalOrderId !== externalOrderId)
            throw new DomainError("INTEGRATION_TRUST_BOUNDARY", "Provider returned a different order", 403);
        const result = await db.transaction(async tx => {
            const imported = await applyCommerceOrder(tx, clock, actorUserId, connection, adapter, order, async guardedTx => {
                await beforeImport?.(guardedTx);
                const owned = await guardedTx.query(`SELECT id FROM integration_connections WHERE id=$1 AND owner_user_id=$2
                  AND status='ACTIVE' AND external_account_reference=$3 FOR UPDATE`, [connectionId, actorUserId, connection.external_account_reference]);
                if (!owned.rows.length) throw integrationDisabled();
            });
            await afterImport?.(tx, imported);
            return imported;
        });
        return {transactionId: result.transactionId, proofId: result.proofId, eligibility: result.eligibility, order};
    } catch (error) {
        if (error instanceof DomainError && ["INTEGRATION_NEEDS_REAUTH", "CONNECTED_ACCOUNT_REAUTH_REQUIRED", "PROVIDER_AUTH_FAILED"].includes(error.code))
            await updateConnectionStatus(db, clock, connectionId, "NEEDS_REAUTH");
        throw error;
    }
}
