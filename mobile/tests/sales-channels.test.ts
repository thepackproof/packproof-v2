import test from "node:test";
import assert from "node:assert/strict";
import { salesChannels, salesChannelCanConnect } from "../src/copy/sales-channels.ts";
import type { ConnectedAccountProviderCatalogView, ConnectedAccountView, IntegrationConnectionView } from "../src/v2-api.ts";

const capabilities = { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: false };
const provider = (name: string, enabled = true): ConnectedAccountProviderCatalogView => ({ provider: name, providerDisplay: name, enabled, capabilities, limitations: [], multipleAccounts: false, requiresShop: name === "shopify" });
const account = (id: string, name = "etsy", external = id): ConnectedAccountView => ({ id, provider: name, providerDisplay: name, externalAccountId: external, externalAccountName: external, status: "ACTIVE", scopes: [], expiresAt: null, capabilities, limitations: [], createdAt: "", updatedAt: "", disconnectedAt: null });
const connection = (id: string, name = "etsy", external = id): IntegrationConnectionView => ({ connectionId: id, adapterKey: name, provider: name, providerDisplay: name, externalAccountReference: external, status: "ACTIVE", lastSyncAt: null, lastErrorCode: null, retryable: false, readyOrderCount: 0 });

test("one card joins permission and ingestion without confusing health", () => {
  const ingest = { ...connection("account-1"), status: "NEEDS_REAUTH", autoSyncEnabled: true };
  const cards = salesChannels([account("account-1")], [ingest], [provider("etsy")]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].accounts.length, 1);
  assert.equal(cards[0].accounts[0].account?.status, "ACTIVE");
  assert.equal(cards[0].accounts[0].connection?.status, "NEEDS_REAUTH");
  assert.equal(salesChannelCanConnect(cards[0]), false);
});

test("reauthorized Shopify connections match normalized identity without leaking another shop", () => {
  const cards = salesChannels([account("new-id", "shopify", "https://first.myshopify.com/")], [connection("old-id", "shopify", "first"), connection("other", "shopify", "second")], [provider("shopify")]);
  assert.equal(cards[0].accounts.length, 2);
  assert.equal(cards[0].accounts[0].connection?.connectionId, "old-id");
  assert.equal(cards[0].accounts[1].account, null);
  assert.equal(cards[0].accounts[1].connection?.connectionId, "other");
});

test("disabled unused providers are absent while unhealthy existing accounts stay visible", () => {
  const cards = salesChannels([{ ...account("shop", "etsy"), status: "NEEDS_REAUTH" }], [], [provider("etsy", false), provider("ebay", false)]);
  assert.deepEqual(cards.map(card => card.provider), ["etsy"]);
  assert.equal(cards[0].accounts[0].account?.status, "NEEDS_REAUTH");
  assert.equal(salesChannelCanConnect(cards[0]), false);
});

test("multiple accounts remain separate under one provider and connection IDs are claimed once", () => {
  const cards = salesChannels([account("first"), account("second")], [connection("first"), connection("second")], [{ ...provider("etsy"), multipleAccounts: true }]);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].accounts.map(row => row.connection?.connectionId), ["first", "second"]);
  assert.equal(salesChannelCanConnect(cards[0]), true);
});
