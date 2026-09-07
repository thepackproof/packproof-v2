import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { auth, login, createHarness, createUser, type TestHarness } from "./helpers.js";
import { createEtsyCommerceAdapter } from "../src/integrations/etsy/commerce-adapter.js";
import type { EtsyClient, EtsyReceipt } from "../src/integrations/etsy/types.js";
import { IntegrationAdapterRegistry } from "../src/integrations/registry.js";
import { ConnectedAccountProviderRegistry } from "../src/integrations/connected-accounts/registry.js";
import type { ConnectedAccountProvider } from "../src/integrations/connected-accounts/types.js";
import { completeConnectedAccountOAuth, disconnectConnectedAccount, reauthorizeConnectedAccount, startConnectedAccountConnect, type ConnectedAccountService } from "../src/domain/connected-accounts.js";
import { executeCommerceFulfillmentSync } from "../src/domain/commerce-fulfillment-sync.js";
import { getCommerceReviewSummary, setCommerceAutomation } from "../src/domain/commerce-automation.js";
import { dispatchCommerceSyncs } from "../src/workers/commerce-worker.js";
import { listFulfillmentQueue } from "../src/domain/fulfillment-queue.js";
import { loadConnection } from "../src/domain/integration-connections.js";
import { providerRateLimited, providerTemporarilyUnavailable } from "../src/domain/integration-errors.js";
import { createEtsyRequestBudget } from "../src/integrations/etsy/request-budget.js";

let instant = Date.parse("2026-09-07T12:00:00Z");
const clock = { now: () => new Date(instant) };
let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; instant = Date.parse("2026-09-07T12:00:00Z"); });
function receipt(id = "9001", overrides: Partial<EtsyReceipt> = {}): EtsyReceipt {
  return {
    receipt_id: id, seller_user_id: "701", buyer_user_id: null, status: "paid", is_paid: true, is_shipped: false,
    create_timestamp: Date.parse("2026-01-01T10:00:00Z") / 1000,
    update_timestamp: Date.parse("2026-01-01T11:00:00Z") / 1000,
    grandtotal: { amount: 4250, divisor: 100, currency_code: "USD" },
    transactions: [{ transaction_id: `8${id}`, receipt_id: id, seller_user_id: "701", title: "Vintage VHS tape", sku: "VHS-1", quantity: 1, is_digital: false, shipped_timestamp: null,
      price: { amount: 4250, divisor: 100, currency_code: "USD" }, variations: [] }],
    shipments: [], refundCount: 0, ...overrides,
  };
}
async function setup(list: EtsyClient["listReceipts"]) {
  const listReceipts = vi.fn(list);
  const client: EtsyClient = {
    listReceipts, getReceipt: async () => receipt(), getShop: async () => ({ shopId: "501", userId: "701", shopName: "VHS Test Shop" }),
    exchangeAuthorizationCode: async () => { throw new Error("not used"); }, refreshUserToken: async () => { throw new Error("not used"); },
  };
  const adapter = createEtsyCommerceAdapter(client, async (_connection, operation) => operation("synthetic-access"));
  const integrations = new IntegrationAdapterRegistry(new Map(), new Map(), new Map(), new Map([["etsy", adapter]]));
  h = await createHarness(clock, { integrations });
  const user = await createUser(h);
  let nextShop = "501";
  const provider: ConnectedAccountProvider = {
    provider: "etsy", displayName: "Etsy", capabilities: { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: false }, limitations: [],
    isEnabled: () => true, oauthPurpose: () => "marketplace_connect", callbackRedirectUri: () => "https://api.packproof.test/oauth/etsy/callback",
    getAuthorizationUrl: async input => ({ authorizationUrl: `https://www.etsy.com/oauth/connect?state=${encodeURIComponent(input.state)}`, redirectUri: input.redirectUri }),
    handleCallback: async () => ({
      tokens: { accessToken: `synthetic-${nextShop}`, refreshToken: "synthetic-refresh", tokenType: "Bearer", expiresAt: new Date(instant + 3_600_000).toISOString(), scopes: ["shops_r", "transactions_r"], extraMaterial: { etsyShopId: nextShop, etsyUserId: "701" } },
      identity: { externalAccountId: nextShop, externalAccountName: "VHS Test Shop", metadata: { etsyShopId: nextShop, etsyUserId: "701" } },
    }),
    refreshCredentials: async () => { throw new Error("not used"); }, getAccountIdentity: async () => { throw new Error("not used"); }, disconnect: async () => undefined,
  };
  const service: ConnectedAccountService = { registry: new ConnectedAccountProviderRegistry(new Map([["etsy", provider]])), credentials: h.credentialStore, packproofEnvironment: "test", webReturnUrl: "https://packproof.test/account" };
  async function connect(shop = "501", accountId?: string) {
    nextShop = shop;
    const started = accountId ? await reauthorizeConnectedAccount(h!.db, clock, user, accountId, service) : await startConnectedAccountConnect(h!.db, clock, user, "etsy", service);
    return completeConnectedAccountOAuth(h!.db, clock, service, "etsy", { code: "synthetic-code", state: new URL(started.authorizationUrl).searchParams.get("state") });
  }
  expect((await connect()).redirectTo).toContain("connected=etsy");
  const connection = (await h.db.query<{ id: string }>("SELECT id FROM integration_connections WHERE provider='etsy'")).rows[0];
  return { h, user, connectionId: connection.id, adapter, integrations, client, listReceipts, service, connect, deps: { integrations, credentials: h.credentialStore } };
}
function page(orders: EtsyReceipt[], input: Parameters<EtsyClient["listReceipts"]>[0], total = orders.length) { return { receipts: orders, total, limit: input.limit ?? 100, offset: input.offset ?? 0 }; }

describe("Etsy canonical automatic fulfillment intake", () => {
  it("runs authenticated HTTP connect, opt-in, background intake and shared Orders with account isolation", async () => {
    const calls = vi.fn(async (input: Parameters<EtsyClient["listReceipts"]>[0]) => page([receipt()], input));
    const tokens = { accessToken: "701.synthetic-access", refreshToken: "701.synthetic-refresh", tokenType: "Bearer" as const, expiresInSeconds: 3600, scopes: ["shops_r", "transactions_r"] };
    const client: EtsyClient = { listReceipts: calls, getReceipt: async () => receipt(), getShop: async () => ({ shopId: "501", userId: "701", shopName: "VHS Test Shop" }), exchangeAuthorizationCode: async () => tokens, refreshUserToken: async () => tokens };
    const integrations = new IntegrationAdapterRegistry(new Map());
    h = await createHarness(clock, { integrations, etsy: { enabled: true, clientId: "synthetic-etsy-key", appCredentialReference: "memory:etsy-app", redirectUri: "https://thepackproof.com/api/oauth/etsy/callback", client } });
    await h.credentialStore.put({ adapterKey: "etsy", credentialReference: "memory:etsy-app", material: { sharedSecret: "synthetic-etsy-secret" } });
    const user = await login(h.app, "etsy-http-seller"), stranger = await login(h.app, "etsy-http-stranger");
    const start = await request(h.app).post("/me/connected-accounts/etsy/connect").set(auth(user)).send({});
    expect(start.status).toBe(201);
    const url = new URL(start.body.authorizationUrl);
    expect(url.origin).toBe("https://www.etsy.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("shops_r transactions_r");
    const callback = await request(h.app).get("/oauth/etsy/callback").query({ code: "synthetic-code", state: url.searchParams.get("state") });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("connected=etsy");
    const accounts = await request(h.app).get("/me/connected-accounts").set(auth(user));
    const connectionId = accounts.body.accounts[0].id;
    expect(accounts.body.accounts[0]).toMatchObject({ provider: "etsy", externalAccountId: "501", status: "CONNECTED" });
    expect(JSON.stringify(accounts.body)).not.toContain("synthetic-etsy-secret");
    expect(JSON.stringify(accounts.body)).not.toContain("701.synthetic-access");
    expect((await request(h.app).post(`/me/commerce-connections/${connectionId}/automation`).set(auth(stranger)).send({ enabled: true })).status).toBe(403);
    const enabled = await request(h.app).post(`/me/commerce-connections/${connectionId}/automation`).set(auth(user)).send({ enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.orderPolicy).toContain("no age cutoff");
    expect(calls).not.toHaveBeenCalled();
    expect(await dispatchCommerceSyncs(h.db, clock, { integrations, credentials: h.credentialStore })).toEqual({ completed: 1, failed: 0 });
    const queue = await request(h.app).get("/me/fulfillment-queue").set(auth(user));
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0]).toMatchObject({ provider: "etsy", proofStatus: "READY_FOR_EVIDENCE", evidenceCount: 0 });
    expect((await request(h.app).get("/me/fulfillment-queue").set(auth(stranger))).body.items).toEqual([]);
    expect((await request(h.app).get(`/proofs/${queue.body.items[0].proofId}`).set(auth(stranger))).status).toBe(403);
    expect((await request(h.app).post(`/me/commerce-connections/${connectionId}/sync`).set(auth(user)).send({})).status).toBe(200);
    expect((await h.db.query("SELECT id FROM proofs")).rows).toHaveLength(1);
    expect((await h.db.query("SELECT id FROM invitations")).rows).toHaveLength(0);
    expect((await h.db.query("SELECT id FROM evidence")).rows).toHaveLength(0);
  });

  it("imports an old pending order only after opt-in and never invents evidence or finalization", async () => {
    const x = await setup(async input => page(input.wasPaid ? [receipt()] : [], input));
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 0, failed: 0 });
    await setCommerceAutomation(x.h.db, clock, x.user, x.connectionId, true, x.integrations);
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 1, failed: 0 });
    expect(x.listReceipts.mock.calls[0][0]).toMatchObject({ wasPaid: true, wasShipped: false, shopId: "501" });
    expect(x.listReceipts.mock.calls[0][0].minLastModified).toBeUndefined();
    expect(x.listReceipts.mock.calls[1][0].wasPaid).toBeUndefined();
    expect((await x.h.db.query("SELECT status,participation_policy FROM proofs")).rows).toEqual([{ status: "READY_FOR_EVIDENCE", participation_policy: "COUNTERPARTY_OPTIONAL" }]);
    expect((await x.h.db.query("SELECT id FROM evidence")).rows).toHaveLength(0);
    expect((await listFulfillmentQueue(x.h.db, x.user))[0]).toMatchObject({ providerDisplay: "Etsy", externalOrderId: "9001", workflowState: "READY_TO_PACK", evidenceCount: 0 });
    const state = (await x.h.db.query<{ next_run_at: Date }>("SELECT next_run_at FROM commerce_connection_sync_states")).rows[0];
    expect(new Date(state.next_run_at).getTime() - instant).toBe(300_000);
    instant += 300_000;
    await dispatchCommerceSyncs(x.h.db, clock, x.deps);
    expect(x.listReceipts.mock.calls).toHaveLength(3);
    expect(x.listReceipts.mock.calls[2][0].wasPaid).toBeUndefined();
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(1);
  });

  it("reuses the same shop+receipt across repeated reads, pause, disconnect and reconnect", async () => {
    const x = await setup(async input => page([receipt()], input));
    await setCommerceAutomation(x.h.db, clock, x.user, x.connectionId, true, x.integrations);
    await dispatchCommerceSyncs(x.h.db, clock, x.deps);
    const original = (await x.h.db.query("SELECT id FROM proofs")).rows;
    await disconnectConnectedAccount(x.h.db, clock, x.user, x.connectionId, x.service);
    expect((await loadConnection(x.h.db, x.connectionId)).status).toBe("DISABLED");
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 0, failed: 0 });
    expect((await x.connect("501")).redirectTo).toContain("connected=etsy");
    expect((await loadConnection(x.h.db, x.connectionId))).toMatchObject({ status: "ACTIVE", auto_sync_enabled: true });
    await dispatchCommerceSyncs(x.h.db, clock, x.deps);
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toEqual(original);
    expect((await x.h.db.query("SELECT id FROM integration_connections")).rows).toHaveLength(1);
    await setCommerceAutomation(x.h.db, clock, x.user, x.connectionId, false, x.integrations);
    instant += 600_000;
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 0, failed: 0 });
  });

  it("keeps identical receipt references separate between shops", async () => {
    const x = await setup(async input => page([receipt()], input));
    await executeCommerceFulfillmentSync(x.h.db, clock, x.user, x.connectionId, x.deps);
    await x.connect("502");
    const second = (await x.h.db.query<{ id: string }>("SELECT id FROM integration_connections WHERE external_account_reference='502'")).rows[0];
    await executeCommerceFulfillmentSync(x.h.db, clock, x.user, second.id, x.deps);
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(2);
    expect((await x.h.db.query("SELECT tenant_key FROM transaction_integration_identities ORDER BY tenant_key")).rows).toEqual([{ tenant_key: "marketplace:etsy:501" }, { tenant_key: "marketplace:etsy:502" }]);
  });

  it("rejects a different shop during reauthorization before replacing the saved credentials", async () => {
    const x = await setup(async input => page([], input));
    const before = await loadConnection(x.h.db, x.connectionId);
    const stored = await x.h.credentialStore.getCredentials({ adapterKey: "etsy", credentialReference: before.credential_reference });
    expect((await x.connect("502", x.connectionId)).redirectTo).toContain("CONNECTED_ACCOUNT_IDENTITY_MISMATCH");
    expect(await x.h.credentialStore.getCredentials({ adapterKey: "etsy", credentialReference: before.credential_reference })).toEqual(stored);
    expect((await x.h.db.query("SELECT id FROM connected_accounts")).rows).toHaveLength(1);
  });

  it("removes cancelled or shipped orders from the ready queue while preserving their existing Proofs", async () => {
    let current = [receipt("9001"), receipt("9002")];
    const x = await setup(async input => page(current, input));
    await executeCommerceFulfillmentSync(x.h.db, clock, x.user, x.connectionId, x.deps);
    current = [receipt("9001", { status: "canceled", update_timestamp: instant / 1000 }), receipt("9002", { status: "completed", is_shipped: true, update_timestamp: instant / 1000 })];
    await executeCommerceFulfillmentSync(x.h.db, clock, x.user, x.connectionId, x.deps);
    expect(await listFulfillmentQueue(x.h.db, x.user)).toEqual([]);
    expect((await x.h.db.query("SELECT status FROM proofs")).rows).toEqual([{ status: "READY_FOR_EVIDENCE" }, { status: "READY_FOR_EVIDENCE" }]);
    expect((await x.h.db.query("SELECT id FROM commerce_order_revisions")).rows).toHaveLength(4);
  });

  it("does not import unpaid, cancelled, shipped, refunded or digital orders", async () => {
    const digital = receipt("9005"); digital.transactions[0].is_digital = true;
    const x = await setup(async input => page([
      receipt("9001", { is_paid: false, status: "open" }), receipt("9002", { status: "canceled" }),
      receipt("9003", { is_shipped: true, status: "completed" }), receipt("9004", { status: "fully refunded", refundCount: 1 }), digital,
    ], input));
    await executeCommerceFulfillmentSync(x.h.db, clock, x.user, x.connectionId, x.deps);
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(0);
    expect((await x.h.db.query("SELECT eligibility FROM commerce_order_records")).rows).toHaveLength(5);
  });

  it("reports unsupported pending physical orders for review without counting closed or digital-only orders", async () => {
    const mixed = receipt("9001");
    mixed.transactions.push({ ...mixed.transactions[0], transaction_id: "890012", is_digital: true });
    const partial = receipt("9002");
    partial.transactions.push({ ...partial.transactions[0], transaction_id: "890022", shipped_timestamp: instant / 1000 });
    const digital = receipt("9003"); digital.transactions[0].is_digital = true;
    const x = await setup(async input => page([mixed, partial, digital, receipt("9004", { is_shipped: true, status: "completed" })], input));
    await executeCommerceFulfillmentSync(x.h.db, clock, x.user, x.connectionId, x.deps);
    expect(await getCommerceReviewSummary(x.h.db, x.connectionId)).toEqual({ reviewOrderCount: 2, reviewReasons: [
      { code: "etsy_mixed_physical_and_digital_order", count: 1 }, { code: "etsy_partial_shipment", count: 1 },
    ] });
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(0);
  });

  it("checkpoints pages and provider retry-after, then resumes without duplicate Proofs", async () => {
    let throttled = true;
    const x = await setup(async input => {
      if (input.wasPaid && input.offset === 1 && throttled) throw Object.assign(providerRateLimited(), { retryAfterSeconds: 3600 });
      return input.wasPaid ? page([receipt(input.offset ? "9002" : "9001")], input, 2) : page([], input);
    });
    await expect(executeCommerceFulfillmentSync(x.h.db, clock, x.user, x.connectionId, x.deps)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    const state = (await x.h.db.query<{ provider_cursor: string; next_run_at: Date }>("SELECT provider_cursor,next_run_at FROM commerce_connection_sync_states")).rows[0];
    expect(JSON.parse(Buffer.from(state.provider_cursor, "base64url").toString())).toMatchObject({ phase: "pending", offset: 1 });
    expect(new Date(state.next_run_at).getTime() - instant).toBe(3_600_000);
    throttled = false;
    expect(await executeCommerceFulfillmentSync(x.h.db, clock, x.user, x.connectionId, x.deps)).toMatchObject({ complete: true, createdProofCount: 1 });
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(2);
  });

  it("keeps automatic intake retrying through exhausted shared quotas and more than eight provider cooldowns", async () => {
    let budget: ReturnType<typeof createEtsyRequestBudget>;
    const x = await setup(async input => { await budget.beforeRequest(); return page([receipt()], input); });
    budget = createEtsyRequestBudget(x.h.db, clock, "synthetic-quota-test-key", { dailyLimit: 3, wait: async milliseconds => { instant += milliseconds; } });
    await budget.beforeRequest(); await budget.beforeRequest(); await budget.beforeRequest();
    await setCommerceAutomation(x.h.db, clock, x.user, x.connectionId, true, x.integrations);
    const syncState = async () => (await x.h.db.query<{run_status:string;attempt_count:number;next_run_at:Date|string;last_error_retryable:boolean}>(
      "SELECT run_status,attempt_count,next_run_at,last_error_retryable FROM commerce_connection_sync_states WHERE connection_id=$1", [x.connectionId])).rows[0];
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 0, failed: 1 });
    expect(await syncState()).toMatchObject({ run_status: "RETRYING", attempt_count: 0, last_error_retryable: true });
    // Move beyond the conservatively retained rolling-day boundary minute.
    instant = new Date((await syncState()).next_run_at).getTime() + 60_000;
    for (let cooldown = 0; cooldown < 9; cooldown++) {
      await budget.afterResponse(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
      expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 0, failed: 1 });
      const state = await syncState();
      expect(state).toMatchObject({ run_status: "RETRYING", attempt_count: 0, last_error_retryable: true });
      expect(new Date(state.next_run_at).getTime() - instant).toBe(120_000);
      instant = new Date(state.next_run_at).getTime();
    }
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(0);
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 1, failed: 0 });
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(1);
    instant = new Date((await syncState()).next_run_at).getTime();
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 1, failed: 0 });
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(1);
  });

  it("still stops after eight ordinary provider failures", async () => {
    const x = await setup(async () => { throw providerTemporarilyUnavailable(); });
    await setCommerceAutomation(x.h.db, clock, x.user, x.connectionId, true, x.integrations);
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 0, failed: 1 });
      const state = (await x.h.db.query<{run_status:string;attempt_count:number;next_run_at:Date|string}>("SELECT run_status,attempt_count,next_run_at FROM commerce_connection_sync_states WHERE connection_id=$1", [x.connectionId])).rows[0];
      expect(state).toMatchObject({ run_status: attempt === 8 ? "FAILED" : "RETRYING", attempt_count: attempt });
      instant = new Date(state.next_run_at).getTime();
    }
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 0, failed: 0 });
  });

  it("fences a paused in-flight response and rejects foreign seller payloads", async () => {
    let paused = false;
    const x = await setup(async input => {
      if (paused) await setCommerceAutomation(x.h.db, clock, x.user, x.connectionId, false, x.integrations);
      return page([receipt()], input);
    });
    await setCommerceAutomation(x.h.db, clock, x.user, x.connectionId, true, x.integrations);
    paused = true;
    expect(await dispatchCommerceSyncs(x.h.db, clock, x.deps)).toEqual({ completed: 0, failed: 1 });
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(0);
    x.listReceipts.mockImplementation(async input => page([receipt("9001", { seller_user_id: "999" })], input));
    await expect(executeCommerceFulfillmentSync(x.h.db, clock, x.user, x.connectionId, x.deps)).rejects.toMatchObject({ code: "INTEGRATION_TRUST_BOUNDARY" });
    expect((await x.h.db.query("SELECT id FROM proofs")).rows).toHaveLength(0);
  });
});
