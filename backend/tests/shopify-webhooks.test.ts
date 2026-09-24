import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHarness, createUser, type TestHarness } from "./helpers.js";
import { createIntegrationConnection, loadConnection } from "../src/domain/integration-connections.js";
import { commerceConnectionCapabilities } from "../src/domain/commerce-automation.js";
import { createDefaultIntegrationRegistry } from "../src/integrations/registry.js";
import { shopifyWebhookHmac } from "../src/integrations/shopify/hmac.js";
import {
  ensureShopifyWebhookSubscriptions, shopifyWebhookCallbackUrl, shopifyWebhookTopicsForScopes,
  SHOPIFY_COMMERCE_WEBHOOK_TOPICS,
} from "../src/integrations/shopify/webhooks.js";
import { createScriptedFetch, FakeShopifyClient } from "./fixtures/connected-accounts.js";

const input = { shop: "proof-store.myshopify.com", accessToken: "fixture-access", callbackUrl: "https://api.packproof.test/integrations/webhooks/shopify", scopes: ["read_orders", "read_merchant_managed_fulfillment_orders", "read_locations"] };
const topics = shopifyWebhookTopicsForScopes(input.scopes);
function row(topic: string, overrides: Record<string, unknown> = {}) {
  return { id: `gid://shopify/WebhookSubscription/${Object.values(topics).indexOf(topic) + 1}`, topic, uri: input.callbackUrl, format: "JSON", filter: null, ...overrides };
}
function page(nodes: unknown[], cursor: string | null = null) {
  return Response.json({ data: { webhookSubscriptions: { nodes, pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor } } } });
}
function success(topic: string, update = false) {
  return Response.json({ data: { [update ? "webhookSubscriptionUpdate" : "webhookSubscriptionCreate"]: { webhookSubscription: row(topic), userErrors: [] } } });
}

describe("Shopify subscription reconciliation", () => {
  it("preserves an API gateway path prefix when deriving the webhook URL", () => {
    expect(shopifyWebhookCallbackUrl("https://thepackproof.com/api/oauth/shopify/callback"))
      .toBe("https://thepackproof.com/api/integrations/webhooks/shopify");
  });
  it("registers all authorized topics and repairs filtered subscriptions only for its configured endpoint", async () => {
    const created: string[] = [], modified: unknown[] = [];
    const fetcher = createScriptedFetch((url, init) => {
      expect(url).toBe(`https://${input.shop}/admin/api/2026-07/graphql.json`);
      expect(init).toMatchObject({ redirect: "error", headers: { "X-Shopify-Access-Token": input.accessToken } });
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("query PackProofWebhookSubscriptions")) {
        expect(variables).toMatchObject({ uri: input.callbackUrl, after: null });
        return page([row("ORDERS_CREATE", { filter: "financial_status:paid" }), row("ORDERS_PAID", { uri: "https://old.packproof.test/hooks" })]);
      }
      if (query.includes("mutation PackProofWebhookUpdate")) {
        modified.push(variables);
        return success("ORDERS_CREATE", true);
      }
      created.push(variables.topic);
      expect(variables.subscription).toMatchObject({ uri: input.callbackUrl, format: "JSON", filter: null });
      if (!String(variables.topic).startsWith("FULFILLMENT_ORDERS_")) expect(variables.subscription.includeFields).toEqual(["id"]);
      return success(variables.topic);
    });
    const result = await ensureShopifyWebhookSubscriptions(input, fetcher);
    expect(result.topics).toEqual(Object.keys(topics));
    expect(created).toHaveLength(Object.keys(topics).length - 1);
    expect(created).toContain("ORDERS_PAID");
    expect(modified).toEqual([{ id: row("ORDERS_CREATE").id, subscription: { uri: input.callbackUrl, format: "JSON", filter: null, includeFields: ["id"] } }]);
  });

  it("paginates existing subscriptions and performs no writes on reconnect", async () => {
    const rows = Object.values(topics).map(topic => row(topic));
    let count = 0;
    const fetcher = createScriptedFetch((_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      expect(query).toContain("query PackProofWebhookSubscriptions");
      count++;
      return variables.after ? page(rows.slice(5)) : page(rows.slice(0, 5), "next");
    });
    const result = await ensureShopifyWebhookSubscriptions(input, fetcher);
    expect(result.subscriptionIds).toHaveLength(Object.keys(topics).length);
    expect(count).toBe(2);
  });

  it("retries partial registration safely and carries HTTP rate-limit retry guidance", async () => {
    const stored: ReturnType<typeof row>[] = [];
    let fail = true;
    const fetcher = createScriptedFetch((_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("query PackProofWebhookSubscriptions")) return page(stored);
      if (stored.length === 2 && fail) return new Response("", { status: 429, headers: { "Retry-After": "45" } });
      expect(stored.some(value => value.topic === variables.topic)).toBe(false);
      stored.push(row(variables.topic));
      return success(variables.topic);
    });
    await expect(ensureShopifyWebhookSubscriptions(input, fetcher)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterSeconds: 45 });
    expect(stored).toHaveLength(2);
    fail = false;
    expect((await ensureShopifyWebhookSubscriptions(input, fetcher)).topics).toHaveLength(Object.keys(topics).length);
    expect(stored).toHaveLength(Object.keys(topics).length);
  });

  it("accepts a create race only after reading back the exact correct subscription", async () => {
    let reads = 0;
    const fetcher = createScriptedFetch((_url, init) => {
      const { query } = JSON.parse(String(init?.body));
      if (query.includes("query PackProofWebhookSubscriptions")) return page(++reads === 1 ? [] : [row("APP_UNINSTALLED")]);
      return Response.json({ data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ["uri"], message: "Webhook already exists" }] } } });
    });
    expect(await ensureShopifyWebhookSubscriptions({ ...input, scopes: [] }, fetcher)).toEqual({ topics: ["app/uninstalled"], subscriptionIds: [row("APP_UNINSTALLED").id] });
    const falseDuplicate = createScriptedFetch((_url, init) => JSON.parse(String(init?.body)).query.includes("query PackProofWebhookSubscriptions")
      ? page([]) : Response.json({ data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: "Webhook already exists" }] } } }));
    await expect(ensureShopifyWebhookSubscriptions({ ...input, scopes: [] }, falseDuplicate)).rejects.toMatchObject({ code: "SHOPIFY_WEBHOOK_REGISTRATION_FAILED" });
  });

  it("respects scopes, rejects insecure callback configuration, and propagates GraphQL throttle costs", async () => {
    expect(Object.keys(shopifyWebhookTopicsForScopes(["read_orders"]))).not.toContain("fulfillment_orders/moved");
    expect(Object.keys(shopifyWebhookTopicsForScopes(["read_orders"]))).toContain("orders/fulfilled");
    expect(shopifyWebhookCallbackUrl("https://api.packproof.test/oauth/shopify/callback")).toBe(input.callbackUrl);
    expect(() => shopifyWebhookCallbackUrl("http://api.packproof.test/oauth/shopify/callback")).toThrow();
    const fetcher = createScriptedFetch(() => Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 100, throttleStatus: { currentlyAvailable: 0, restoreRate: 20 } } } }));
    await expect(ensureShopifyWebhookSubscriptions(input, fetcher)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterSeconds: 5 });
  });
});

let harness: TestHarness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });
const clock = { now: () => new Date("2026-09-24T12:00:00Z") };
async function boot() {
  harness = await createHarness(clock, { shopify: { enabled: true, clientId: "fixture-client", appCredentialReference: "memory:shopify-app", redirectUri: "http://127.0.0.1/oauth/shopify/callback", client: new FakeShopifyClient() } });
  await harness.credentialStore.put({ adapterKey: "shopify", credentialReference: "memory:shopify-app", material: { clientSecret: "fixture-secret" } });
  return harness;
}
function delivery(h: TestHarness, topic: string, id = topic, shop = input.shop, validHmac = true) {
  const body = '{"id":123,"customer":{"email":"never-store-this@example.test"}}';
  return request(h.app).post("/integrations/webhooks/shopify")
    .set("Content-Type", "application/json").set("X-Shopify-Topic", topic).set("X-Shopify-Webhook-Id", id)
    .set("X-Shopify-Shop-Domain", shop).set("X-Shopify-Hmac-Sha256", validHmac ? shopifyWebhookHmac("fixture-secret", Buffer.from(body)) : "invalid").send(body);
}
describe("Shopify event ingestion", () => {
  it("authenticates, durably deduplicates every lifecycle invalidation, and never stores the webhook payload", async () => {
    const h = await boot(), owner = await createUser(h);
    const connection = await createIntegrationConnection(h.db, clock, owner, { adapterKey: "shopify", provider: "shopify", externalAccountReference: "proof-store", credentialReference: "memory:shopify-store" });
    await h.db.query("UPDATE integration_connections SET auto_sync_enabled=true WHERE id=$1", [connection.connectionId]);
    expect((await delivery(h, "orders/create", "bad-signature", input.shop, false)).status).toBe(401);
    for (const topic of SHOPIFY_COMMERCE_WEBHOOK_TOPICS) {
      const response = await delivery(h, topic);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ accepted: true, queued: true });
      expect((await delivery(h, topic)).body).toEqual({ accepted: true, queued: false });
    }
    expect((await delivery(h, "orders/updated", "foreign-store", "other.myshopify.com")).body).toEqual({ accepted: true, queued: false });
    const inbox = (await h.db.query("SELECT * FROM commerce_webhook_inbox")).rows;
    expect(inbox).toHaveLength(SHOPIFY_COMMERCE_WEBHOOK_TOPICS.length);
    expect(JSON.stringify(inbox)).not.toContain("never-store-this");
    expect((await h.db.query("SELECT next_run_at FROM commerce_connection_sync_states WHERE connection_id=$1", [connection.connectionId])).rows[0]).toBeTruthy();
    const capabilities = await commerceConnectionCapabilities(h.db, await loadConnection(h.db, connection.connectionId), createDefaultIntegrationRegistry(clock, { testFixtures: true }));
    expect(capabilities).toMatchObject({ webhookDeliveryVerified: true, lastWebhookReceivedAt: clock.now().toISOString(), webhookSubscriptionsVerified: false, webhookTopics: [] });
  });

  it("does not silently acknowledge privacy requests and verifies HMAC before processing any topic", async () => {
    const h = await boot();
    for (const topic of ["customers/data_request", "customers/redact", "shop/redact"]) {
      const response = await delivery(h, topic);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("SHOPIFY_PRIVACY_HANDLER_UNAVAILABLE");
      expect((await delivery(h, topic, topic, input.shop, false)).status).toBe(401);
    }
    expect((await h.db.query("SELECT id FROM commerce_webhook_inbox")).rows).toEqual([]);
  });
});
