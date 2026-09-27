import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import request from "supertest";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";
import { FakeShopifyClient } from "./fixtures/connected-accounts.js";
import { createDefaultIntegrationRegistry } from "../src/integrations/registry.js";
import { dispatchCommerceSyncs } from "../src/workers/commerce-worker.js";
import { setCommerceAutomation } from "../src/domain/commerce-automation.js";
import { shopifyWebhookHmac } from "../src/integrations/shopify/hmac.js";

let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function setup() {
  const now = { value: Date.now() };
  const clock = { now: () => new Date(now.value) };
  const client = new FakeShopifyClient();
  const integrations = createDefaultIntegrationRegistry(clock, { shopifyClient: client });
  h = await createHarness(clock, {
    integrations,
    shopify: { enabled: true, clientId: "fixture-client", appCredentialReference: "memory:shopify-app",
      redirectUri: "http://127.0.0.1/oauth/shopify/callback", client },
  });
  await h.credentialStore.put({ adapterKey: "shopify", credentialReference: "memory:shopify-app", material: { clientSecret: "shopify-secret" } });
  const user = await login(h.app, "shopify-flow-seller");
  return { harness: h, client, integrations, user, clock, now,
    deps: { integrations, credentials: h.credentialStore, automationProviders: ["shopify"] } };
}

async function connect(harness: TestHarness, user: string, consent?: boolean) {
  const started = await request(harness.app).post("/me/connected-accounts/shopify/connect").set(auth(user))
    .send({ shop: "packproof-test", ...(consent === undefined ? {} : { autoSyncEnabled: consent }) });
  expect(started.status).toBe(201);
  const query: Record<string, string> = { code: "valid-shopify-code", shop: "packproof-test.myshopify.com",
    state: new URL(started.body.authorizationUrl).searchParams.get("state")!, timestamp: String(Math.floor(harness.clock.now().getTime() / 1000)) };
  const signature = createHmac("sha256", "shopify-secret").update(Object.keys(query).sort().map(key => `${key}=${query[key]}`).join("&")).digest("hex");
  const callback = await request(harness.app).get("/oauth/shopify/callback").query({ ...query, hmac: signature });
  expect(callback.headers.location).toContain("connected=shopify");
  return (await harness.db.query<{ id: string; auto_sync_enabled: boolean }>("SELECT id,auto_sync_enabled FROM integration_connections WHERE provider='shopify' AND owner_user_id=$1", [user])).rows[0];
}

describe("Shopify connect to automatic Proof creation", () => {
  it("does not register an unguarded live Shopify adapter by default", () => {
    expect(createDefaultIntegrationRegistry({now: () => new Date()}).hasCommerce("shopify")).toBe(false);
  });
  it.each([undefined, false])("does not opt a seller in when initial consent is %s", async consent => {
    const { harness, user, deps } = await setup();
    expect((await connect(harness, user, consent)).auto_sync_enabled).toBe(false);
    expect(await dispatchCommerceSyncs(harness.db, harness.clock, deps)).toEqual({ completed: 0, failed: 0 });
    expect((await harness.db.query("SELECT id FROM proofs")).rows).toHaveLength(0);
  });

  it("rejects non-boolean consent before creating OAuth state", async () => {
    const { harness, user } = await setup();
    const response = await request(harness.app).post("/me/connected-accounts/shopify/connect").set(auth(user))
      .send({ shop: "packproof-test", autoSyncEnabled: "true" });
    expect(response.status).toBe(400);
    expect((await harness.db.query("SELECT id FROM oauth_authorization_attempts")).rows).toHaveLength(0);
  });

  it("starts a Proof through the worker, deduplicates deliveries, and preserves pause on reconnect", async () => {
    const { harness, user, deps, integrations, client, clock, now } = await setup();
    const connection = await connect(harness, user, true);
    expect(connection.auto_sync_enabled).toBe(true);
    expect(await dispatchCommerceSyncs(harness.db, clock, { ...deps, automationProviders: [] })).toEqual({ completed: 0, failed: 0 });
    expect(await dispatchCommerceSyncs(harness.db, clock, deps)).toEqual({ completed: 1, failed: 0 });
    const proof = (await harness.db.query("SELECT id,status FROM proofs")).rows;
    expect(proof).toHaveLength(1);
    expect(proof[0].status).toBe("READY_FOR_EVIDENCE");
    expect((await harness.db.query("SELECT id FROM evidence")).rows).toHaveLength(0);

    const raw = JSON.stringify({ id: "payload-is-invalidation-only" });
    const send = () => request(harness.app).post("/integrations/webhooks/shopify")
      .set("Content-Type", "application/json").set("X-Shopify-Topic", "fulfillment_orders/order_routing_complete")
      .set("X-Shopify-Shop-Domain", "packproof-test.myshopify.com").set("X-Shopify-Webhook-Id", "one-provider-delivery")
      .set("X-Shopify-Hmac-Sha256", shopifyWebhookHmac("shopify-secret", Buffer.from(raw))).send(raw);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await harness.db.query("SELECT id FROM commerce_webhook_inbox")).rows).toHaveLength(1);
    expect(await dispatchCommerceSyncs(harness.db, clock, deps)).toEqual({ completed: 1, failed: 0 });
    expect((await harness.db.query("SELECT id,status FROM proofs")).rows).toEqual(proof);

    await setCommerceAutomation(harness.db, clock, user, connection.id, false, integrations);
    expect((await connect(harness, user, true)).auto_sync_enabled).toBe(false);
    client.orders.push({ ...client.orders[0], id: "1002", name: "#1002" });
    now.value += 600_000;
    expect(await dispatchCommerceSyncs(harness.db, clock, deps)).toEqual({ completed: 0, failed: 0 });
    await setCommerceAutomation(harness.db, clock, user, connection.id, true, integrations);
    expect(await dispatchCommerceSyncs(harness.db, clock, deps)).toEqual({ completed: 1, failed: 0 });
    expect((await harness.db.query("SELECT id FROM proofs")).rows).toHaveLength(2);
  });
});
