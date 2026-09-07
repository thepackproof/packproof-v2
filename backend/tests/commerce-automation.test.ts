import { finalizeProof } from "../src/domain/finalize.js";
import { updateTransaction } from "../src/domain/transactions.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, createUser, commitFulfillmentAndAttest, type TestHarness } from "./helpers.js";
import { createIntegrationConnection } from "../src/domain/integration-connections.js";
import { executeCommerceFulfillmentSync } from "../src/domain/commerce-fulfillment-sync.js";
import { enqueueCommerceWebhook, setCommerceAutomation } from "../src/domain/commerce-automation.js";
import { dispatchCommerceSyncs } from "../src/workers/commerce-worker.js";
import { IntegrationAdapterRegistry } from "../src/integrations/registry.js";
import { providerRateLimited } from "../src/domain/integration-errors.js";
import type { CommerceFulfillmentAdapter } from "../src/integrations/commerce-fulfillment-adapter.js";
import type { NormalizedFulfillmentOrder } from "../src/domain/normalized-fulfillment-order.js";
import { createHttpEbayClient } from "../src/integrations/ebay/client.js";
const now = { value: Date.parse("2026-09-05T12:00:00Z") };
const clock = { now: () => new Date(now.value) };
const order = (id: string, account = "store-one", extra: Partial<NormalizedFulfillmentOrder> = {}): NormalizedFulfillmentOrder => ({ provider: "test-store", externalAccountReference: account, externalOrderId: id, externalReference: id, orderedAt: "2026-09-04T12:00:00Z", paymentState: "CONFIRMED", fulfillmentState: "AWAITING_FULFILLMENT", requiresPhysicalFulfillment: true, cancelled: false, items: [{ externalItemId: "line-one", position: 1, title: "Trading card", description: null, sku: "CARD", quantity: 2, unitValue: 20, currency: "USD" }], transactionValue: 40, currency: "USD", buyer: null, shipping: null, providerUpdatedAt: "2026-09-05T11:00:00Z", provenance: { source: "STOREFRONT_API", sourceRecordId: id }, ...extra });
let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; now.value = Date.parse("2026-09-05T12:00:00Z"); });
async function setup(list: CommerceFulfillmentAdapter["listFulfillmentOrders"]) {
    const adapter: CommerceFulfillmentAdapter = { adapterKey: "test-store", provider: "test-store", displayName: "Test store", kind: "reference", listFulfillmentOrders: list };
    const integrations = new IntegrationAdapterRegistry(new Map(), new Map(), new Map(), new Map([[adapter.adapterKey, adapter]]));
    h = await createHarness(clock, { integrations });
    const user = await createUser(h);
    const connection = await createIntegrationConnection(h.db, clock, user, { adapterKey: "test-store", provider: "test-store", externalAccountReference: "store-one", credentialReference: "reference:test" });
    return { h, user, connection, integrations, deps: { integrations, credentials: h.credentialStore } };
}
describe("durable automatic commerce intake", () => {
    it("completes pages, clears its cursor and deduplicates repeated reads", async () => {
        const list = vi.fn(async ({ cursor }: Parameters<CommerceFulfillmentAdapter["listFulfillmentOrders"]>[0]) => ({ orders: [order(cursor ? "two" : "one")], cursor: cursor ? null : "second" }));
        const { h, user, connection, deps } = await setup(list);
        expect(await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps)).toMatchObject({ complete: true, cursor: null, createdProofCount: 2, discoveredCount: 2 });
        await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps);
        expect((await h.db.query("SELECT id FROM proofs")).rows).toHaveLength(2);
        expect((await h.db.query("SELECT provider_cursor FROM commerce_connection_sync_states")).rows[0].provider_cursor).toBeNull();
        expect(list.mock.calls.map(([i]) => i.cursor)).toEqual([null, "second", null, "second"]);
    });
    it("resumes a failed page after rate limiting and records backoff", async () => {
        let fail = true;
        const list = vi.fn(async ({ cursor }: Parameters<CommerceFulfillmentAdapter["listFulfillmentOrders"]>[0]) => { if (cursor && fail)
            throw providerRateLimited(); return { orders: [order(cursor ? "two" : "one")], cursor: cursor ? null : "second" }; });
        const { h, user, connection, deps } = await setup(list);
        await expect(executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
        expect((await h.db.query("SELECT * FROM commerce_connection_sync_states")).rows[0]).toMatchObject({ provider_cursor: "second", run_status: "RETRYING", attempt_count: 0, last_error_retryable: true });
        fail = false;
        expect(await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps)).toMatchObject({ createdProofCount: 1, complete: true });
        expect(list.mock.calls.map(([i]) => i.cursor)).toEqual([null, "second", "second"]);
    });
    it("keeps newer cancellations and append-only source history", async () => {
        let current = order("same");
        const { h, user, connection, deps } = await setup(async () => ({ orders: [current], cursor: null }));
        await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps);
        current = order("same", "store-one", { cancelled: true, providerUpdatedAt: "2026-09-05T12:00:00Z" });
        await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps);
        current = order("same");
        expect((await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps)).staleCount).toBe(1);
        expect((await h.db.query("SELECT cancelled,eligibility FROM commerce_order_records")).rows[0]).toMatchObject({ cancelled: true, eligibility: "INELIGIBLE" });
        expect((await h.db.query("SELECT id FROM proofs")).rows).toHaveLength(1);
        expect((await h.db.query("SELECT id FROM commerce_order_revisions")).rows).toHaveLength(2);
        await expect(h.db.query("DELETE FROM commerce_order_revisions")).rejects.toThrow("append-only");
    });
    it("preserves a finalized core and journals later provider edits as a supplement", async () => {
        let current = order("frozen");
        const { h, user, connection, deps } = await setup(async () => ({ orders: [current], cursor: null }));
        await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps);
        const proof = (await h.db.query<{
            id: string;
        }>("SELECT id FROM proofs")).rows[0];
        await commitFulfillmentAndAttest(h, user, proof.id);
        await finalizeProof(h.db, clock, user, proof.id);
        const before = (await h.db.query("SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1", [proof.id])).rows[0];
        current = order("frozen", "store-one", { transactionValue: 50, providerUpdatedAt: "2026-09-05T12:00:00Z" });
        expect(await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps)).toMatchObject({ complete: true, supplementCount: 1 });
        expect((await h.db.query("SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1", [proof.id])).rows[0]).toEqual(before);
        expect((await h.db.query("SELECT disposition FROM commerce_order_revisions ORDER BY id DESC LIMIT 1")).rows[0].disposition).toBe("SUPPLEMENT");
    });
    it("labels seller corrections and preserves them through provider refresh", async () => {
        let current = order("corrected");
        const { h, user, connection, deps } = await setup(async () => ({ orders: [current], cursor: null }));
        await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps);
        const txn = (await h.db.query<{
            id: string;
        }>("SELECT id FROM transactions")).rows[0];
        const updated = await updateTransaction(h.db, clock, user, txn.id, { itemTitle: "Seller corrected title" });
        expect(updated.provenance).toMatchObject({ source: "PARTICIPANT_SUPPLIED", originalSource: "STOREFRONT_API", sellerCorrectedFields: ["itemTitle"] });
        current = order("corrected", "store-one", { transactionValue: 45, providerUpdatedAt: "2026-09-05T12:00:00Z" });
        await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps);
        expect((await h.db.query("SELECT item_title,transaction_value FROM transactions WHERE id=$1", [txn.id])).rows[0]).toMatchObject({ item_title: "Seller corrected title" });
    });
    it("creates background Proofs only after opt-in and honors pause", async () => {
        const { h, user, connection, deps, integrations } = await setup(async () => ({ orders: [order("background-sale")], cursor: null }));
        expect(await dispatchCommerceSyncs(h.db, clock, deps)).toEqual({ completed: 0, failed: 0 });
        await setCommerceAutomation(h.db, clock, user, connection.connectionId, true, integrations);
        expect(await dispatchCommerceSyncs(h.db, clock, deps)).toEqual({ completed: 1, failed: 0 });
        expect((await h.db.query("SELECT id FROM proofs")).rows).toHaveLength(1);
        await setCommerceAutomation(h.db, clock, user, connection.connectionId, false, integrations);
        now.value += 120000;
        expect(await dispatchCommerceSyncs(h.db, clock, deps)).toEqual({ completed: 0, failed: 0 });
    });
    it("deduplicates webhook invalidations and rejects foreign store payloads", async () => {
        const { h, user, connection, deps, integrations } = await setup(async () => ({ orders: [order("foreign", "other-store")], cursor: null }));
        await setCommerceAutomation(h.db, clock, user, connection.connectionId, true, integrations);
        const event = { provider: "test-store", externalAccountReference: "store-one", deliveryId: "one", topic: "orders/updated" };
        await enqueueCommerceWebhook(h.db, clock, event);
        await enqueueCommerceWebhook(h.db, clock, event);
        expect((await h.db.query("SELECT id FROM commerce_webhook_inbox")).rows).toHaveLength(1);
        await expect(executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps)).rejects.toMatchObject({ code: "INTEGRATION_TRUST_BOUNDARY" });
        expect((await h.db.query("SELECT id FROM proofs")).rows).toHaveLength(0);
    });
    it("rejects overlapping leases and recovers after a worker restart", async () => {
        const { h, user, connection, deps } = await setup(async () => ({ orders: [order("one")], cursor: null }));
        await h.db.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at,lease_token,lease_expires_at,run_status) VALUES($1,$2,'old',$3,'RUNNING')`, [connection.connectionId, clock.now().toISOString(), new Date(now.value + 60000).toISOString()]);
        await expect(executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps)).rejects.toMatchObject({ code: "COMMERCE_SYNC_IN_PROGRESS" });
        now.value += 60001;
        expect(await executeCommerceFulfillmentSync(h.db, clock, user, connection.connectionId, deps)).toMatchObject({ createdProofCount: 1, complete: true });
    });
});
describe("provider transport", () => {
    it("classifies an invalid eBay refresh grant as an authorization failure", async () => {
      const client=createHttpEbayClient(vi.fn(async()=>new Response(JSON.stringify({error:"invalid_grant"}),{status:400})));
      await expect(client.refreshUserToken({environment:"sandbox",clientId:"client",clientSecret:"secret",refreshToken:"revoked"})).rejects.toMatchObject({code:"PROVIDER_AUTH_FAILED"});
    });
    it("preserves the eBay refresh token when only a new access token is returned", async () => {
        const client = createHttpEbayClient(vi.fn(async () => new Response(JSON.stringify({ access_token: "renewed", expires_in: 7200, token_type: "User Access Token" }))));
        expect(await client.refreshUserToken({ environment: "sandbox", clientId: "client", clientSecret: "server-secret", refreshToken: "existing-refresh" })).toMatchObject({ accessToken: "renewed", refreshToken: "existing-refresh" });
    });
});
