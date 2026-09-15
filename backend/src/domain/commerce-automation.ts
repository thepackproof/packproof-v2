import { sha256Hex } from "../hash.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import type { IntegrationConnectionRow } from "./integration-connections.js";
import { asIso } from "./types.js";
import { loadConnection } from "./integration-connections.js";
import { loadCommerceSyncState, syncStateView } from "./commerce-order-records.js";
import type { IntegrationAdapterRegistry } from "../integrations/registry.js";
export const AUTOMATIC_ORDER_POLICY = "Available paid physical orders requiring fulfillment, updated in the last 60 days. Cancelled, fully fulfilled, unpaid and digital-only orders do not create Proofs. No label or buyer account is required.";
export const ETSY_AUTOMATIC_ORDER_POLICY = "Paid, unshipped physical Etsy orders create a Proof ready for recording. Pending orders have no age cutoff. Updates sync about every five minutes while PackProof is closed; mixed, partially shipped or incomplete orders are held for review. No buyer account or shipping label is required.";
export function commerceOrderPolicy(adapterKey: string): string {
    return adapterKey === "etsy" ? ETSY_AUTOMATIC_ORDER_POLICY : AUTOMATIC_ORDER_POLICY;
}
/** Seller-facing review counts are operational source data, never fabricated Proofs. */
export async function getCommerceReviewSummary(db: Database, connectionId: string): Promise<{
    reviewOrderCount: number;
    reviewReasons: Array<{ code: string; count: number }>;
}> {
    const reasons = (await db.query<{ code: string; count: string | number }>(`
      SELECT rev.normalized_order->>'pilotCaptureExclusion' AS code,COUNT(*) AS count
      FROM commerce_order_records r
      JOIN commerce_order_revisions rev ON rev.order_record_id=r.id AND rev.fingerprint=r.normalized_fingerprint
      JOIN integration_connections c ON c.id=r.connection_id
      WHERE r.connection_id=$1 AND c.provider='etsy' AND r.eligibility='INELIGIBLE'
        AND r.payment_state='CONFIRMED' AND r.cancelled=false AND r.fulfillment_state NOT IN ('FULFILLED','CANCELLED')
        AND rev.normalized_order->>'pilotCaptureExclusion' IN (
          'etsy_incomplete_fulfillment_details','etsy_multiple_shipments','etsy_partial_shipment',
          'etsy_mixed_physical_and_digital_order','etsy_unknown_fulfillment','etsy_inconsistent_currency','etsy_unconfirmed_order_status')
      GROUP BY rev.normalized_order->>'pilotCaptureExclusion' ORDER BY code`, [connectionId])).rows;
    const reviewReasons = reasons.map(row => ({ code: row.code, count: Number(row.count) }));
    return { reviewOrderCount: reviewReasons.reduce((sum, row) => sum + row.count, 0), reviewReasons };
}
export async function setCommerceAutomation(db: Database, clock: Clock, userId: string, connectionId: string, enabled: unknown, integrations: IntegrationAdapterRegistry, automationProviders?: readonly string[]) {
    if (typeof enabled !== "boolean")
        throw new DomainError("INVALID_AUTOMATION_SETTING", "Choose whether to sync orders automatically", 400);
    const connection = await loadConnection(db, connectionId);
    if (connection.owner_user_id !== userId)
        throw new DomainError("PARTICIPANT_NOT_AUTHORIZED", "This connection belongs to another account", 403);
    integrations.getCommerce(connection.adapter_key);
    if (enabled && automationProviders && !automationProviders.includes(connection.provider))
        throw new DomainError("COMMERCE_AUTOMATION_UNAVAILABLE", "Automatic orders are not available for this store yet. You can still add an order explicitly.", 409);
    if (enabled && connection.status !== "ACTIVE")
        throw new DomainError("INTEGRATION_NEEDS_REAUTH", "Reconnect the store before enabling automatic orders", 409);
    await db.transaction(async (tx) => {
        await tx.query("UPDATE integration_connections SET auto_sync_enabled=$2,updated_at=$3 WHERE id=$1", [connectionId, enabled, clock.now().toISOString()]);
        // Pausing fences any in-flight importer before it can commit another order.
        await tx.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at,next_run_at) VALUES($1,$2,$2)
      ON CONFLICT(connection_id) DO UPDATE SET next_run_at=$2,run_status='IDLE',attempt_count=0,
      last_error_code=NULL,last_error_retryable=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=$2`, [connectionId, clock.now().toISOString()]);
    });
    return { connectionId, autoSyncEnabled: enabled, orderPolicy: commerceOrderPolicy(connection.adapter_key), sync: syncStateView(await loadCommerceSyncState(db, connectionId)) };
}
/** OAuth reconnect retains the seller's previous opt-in and resumes outstanding checkpoints. */
export async function resumeCommerceAutomation(db: Database, clock: Clock, connectionId: string) {
    await db.query(`UPDATE commerce_connection_sync_states SET run_status='IDLE',attempt_count=0,last_error_code=NULL,last_error_retryable=NULL,
    next_run_at=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=$2 WHERE connection_id=$1`, [connectionId, clock.now().toISOString()]);
}
/** Called only after transport HMAC validation. Store a minimal durable invalidation, never credentials or raw buyer data. */
export async function enqueueCommerceWebhook(db: Database, clock: Clock, input: {
    provider: string;
    externalAccountReference: string;
    deliveryId: string;
    topic: string;
}) {
    if (!input.deliveryId || input.deliveryId.length > 200)
        throw new DomainError("INVALID_WEBHOOK", "A valid delivery ID is required", 400);
    const connection = (await db.query<{
        id: string;
    }>("SELECT id FROM integration_connections WHERE provider=$1 AND external_account_reference=$2 AND status='ACTIVE' AND auto_sync_enabled=true", [input.provider, input.externalAccountReference])).rows[0];
    if (!connection)
        return { accepted: true, queued: false };
    await db.transaction(async (tx) => {
        // Keep the existing unique constraint compatible with old binaries while scoping new delivery identities.
        const deliveryIdentity = "account-v1:" + sha256Hex(`${input.provider}\n${input.externalAccountReference}\n${input.deliveryId}`);
        const inserted = await tx.query(`INSERT INTO commerce_webhook_inbox(id,connection_id,provider,delivery_id,topic,received_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,delivery_id) DO NOTHING RETURNING id`, [newId("cwh"), connection.id, input.provider, deliveryIdentity, input.topic, clock.now().toISOString()]);
        if (inserted.rows[0])
            await tx.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at,next_run_at) VALUES($1,$2,$2)
      ON CONFLICT(connection_id) DO UPDATE SET next_run_at=$2`, [connection.id, clock.now().toISOString()]);
    });
    return { accepted: true, queued: true };
}
export async function getCommerceOrderContext(db: Database, userId: string, transactionId: string) {
    const authorized = await db.query(`SELECT t.id FROM transactions t WHERE t.id=$1 AND
    (t.created_by=$2 OR EXISTS(SELECT 1 FROM proofs p JOIN proof_participants pp ON pp.proof_id=p.id WHERE p.transaction_id=t.id AND pp.user_id=$2))`, [transactionId, userId]);
    if (!authorized.rows[0])
        throw new DomainError("PARTICIPANT_NOT_AUTHORIZED", "This order context is private", 403);
    const record = (await db.query("SELECT * FROM commerce_order_records WHERE transaction_id=$1", [transactionId])).rows[0];
    if (!record)
        return { order: null, revisions: [], orderPolicy: AUTOMATIC_ORDER_POLICY };
    const revisions = (await db.query(`SELECT id AS "revisionId",provider_updated_at AS "providerUpdatedAt",observed_at AS "observedAt",
    mapping_version AS "mappingVersion",disposition,fingerprint,normalized_order AS "order" FROM commerce_order_revisions
    WHERE order_record_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 100`, [record.id])).rows;
    const latest=(await db.query<{normalized_order:unknown}>("SELECT normalized_order FROM commerce_order_revisions WHERE order_record_id=$1 AND fingerprint=$2",[record.id,record.normalized_fingerprint])).rows[0];
    return { order: { connectionId: record.connection_id, externalOrderId: record.external_order_id, eligibility: record.eligibility, paymentState: record.payment_state, fulfillmentState: record.fulfillment_state, cancelled: record.cancelled,
            latestSource: latest?.normalized_order ?? null }, revisions, orderPolicy: AUTOMATIC_ORDER_POLICY };
}

/** Independent rollout switch; absent config starts all new provider automation disabled. */
export function commerceAutomationProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    return [...new Set((env.PACKPROOF_COMMERCE_AUTOMATION_PROVIDERS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(value => ["ebay", "shopify", "etsy"].includes(value)))];
}

/** Safe capability evidence from existing account/sync metadata. Never reads credential material. */
export async function commerceConnectionCapabilities(db: Database, connection: IntegrationConnectionRow,
    integrations: IntegrationAdapterRegistry, automationProviders?: readonly string[]) {
    const adapter = integrations.hasCommerce(connection.adapter_key) ? integrations.getCommerce(connection.adapter_key) : null;
    const account = (await db.query<{scopes: unknown; provider_metadata: Record<string, unknown>}>(`
      SELECT scopes,provider_metadata FROM connected_accounts WHERE user_id=$1 AND provider=$2
        AND (id=$3 OR credential_reference=$4) ORDER BY updated_at DESC LIMIT 1`,
      [connection.owner_user_id, connection.provider, connection.id, connection.credential_reference])).rows[0];
    const state = await loadCommerceSyncState(db, connection.id);
    const latestRead = (await db.query<{last_read_at: Date | string | null}>("SELECT MAX(last_seen_at) AS last_read_at FROM commerce_order_records WHERE connection_id=$1", [connection.id])).rows[0]?.last_read_at;
    const lastOrderReadAt = [state?.last_succeeded_at, latestRead].filter((value): value is string | Date => value != null)
        .sort((a,b) => new Date(b).getTime() - new Date(a).getTime())[0];
    const enabled = !automationProviders || automationProviders.includes(connection.provider);
    const metadata = account?.provider_metadata ?? {};
    const safeText = (value: unknown) => typeof value === "string" && value.length <= 200 ? value : null;
    const grantedScopes = Array.isArray(account?.scopes) ? account.scopes.filter((value): value is string => typeof value === "string" && value.length <= 250).slice(0,50) : [];
    const webhookTopics = connection.provider === "shopify" ? ["orders/create", "orders/updated", "orders/cancelled", "orders/paid", "fulfillments/create", "fulfillments/update"] : [];
    return {
        automationAvailable: Boolean(adapter && enabled && connection.status === "ACTIVE"),
        automationUnavailableReason: !adapter ? "ADAPTER_UNAVAILABLE" : !enabled ? "ROLLOUT_DISABLED" : connection.status !== "ACTIVE" ? "RECONNECT_REQUIRED" : null,
        stableAccountId: safeText(metadata.ebayUserId) ?? safeText(metadata.shopId) ?? connection.external_account_reference,
        environment: connection.provider === "shopify" ? "production" : safeText(metadata.environment),
        grantedScopes, exactOrderReadSupported: Boolean(adapter?.fetchFulfillmentOrder),
        incrementalListSupported: Boolean(adapter), paginationSupported: Boolean(adapter),
        lastOrderReadAt: lastOrderReadAt ? asIso(lastOrderReadAt) : null,
        orderReadVerified: Boolean(lastOrderReadAt),
        webhookTopics, webhookDeliveryVerified: false,
        pollIntervalSeconds: adapter ? (adapter.preferredPollIntervalMs ?? 300000) / 1000 : null,
    };
}
