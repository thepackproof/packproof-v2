import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createHttpShopifyClient } from "../src/integrations/shopify/client.js";
import { createShopifyAccessTokenRunner } from "../src/integrations/shopify/access.js";
import { createShopifyConnectedAccountProvider, type ShopifyOAuthRuntime } from "../src/integrations/connected-accounts/providers/shopify.js";
import { createConnectedAccountRegistry, disabledConnectedAccountRuntimes } from "../src/integrations/connected-accounts/runtime.js";
import { disabledEbayRuntime } from "../src/integrations/ebay/runtime.js";
import { completeConnectedAccountOAuth, disconnectConnectedAccount, handleShopifyAppUninstalled, refreshConnectedAccountCredentials, startConnectedAccountConnect, type ConnectedAccountService } from "../src/domain/connected-accounts.js";
import { loadConnectedAccount, updateConnectedAccount } from "../src/domain/connected-account-records.js";
import { loadConnection } from "../src/domain/integration-connections.js";
import { providerAuthFailed, providerTemporarilyUnavailable } from "../src/domain/integration-errors.js";
import { createHarness, createUser, type TestHarness } from "./helpers.js";
import { FakeShopifyClient } from "./fixtures/connected-accounts.js";

const shop = "packproof-test.myshopify.com";
const appCredentials = { shop, clientId: "shopify-app-id", clientSecret: "shopify-secret" };
const scope = "read_orders,read_merchant_managed_fulfillment_orders,read_locations";
const payload = () => ({ access_token: "new-access", refresh_token: "new-refresh", scope, expires_in: 3600, refresh_token_expires_in: 7_776_000 });

describe("Shopify expiring offline HTTP tokens", () => {
  it("requests expiring offline access and retains both token lifetimes", async () => {
    const fetcher = vi.fn(async () => Response.json(payload()));
    const result = await createHttpShopifyClient(fetcher).exchangeAuthorizationCode({ ...appCredentials, code: "once-only-code" });
    expect(result).toEqual({ accessToken: "new-access", refreshToken: "new-refresh", scope, expiresInSeconds: 3600, refreshTokenExpiresInSeconds: 7_776_000 });
    expect(fetcher).toHaveBeenCalledWith(`https://${shop}/admin/oauth/access_token`, expect.objectContaining({ method: "POST", redirect: "error" }));
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ client_id: appCredentials.clientId, client_secret: appCredentials.clientSecret, code: "once-only-code", expiring: 1 });
  });

  it("refreshes using the rotating offline refresh-token grant", async () => {
    const fetcher = vi.fn(async () => Response.json(payload()));
    await createHttpShopifyClient(fetcher).refreshUserToken!({ ...appCredentials, refreshToken: "previous-refresh" });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ client_id: appCredentials.clientId, client_secret: appCredentials.clientSecret, grant_type: "refresh_token", refresh_token: "previous-refresh" });
  });

  it.each([
    { refresh_token: undefined }, { expires_in: undefined }, { expires_in: 0 },
    { expires_in: -5 }, { refresh_token_expires_in: undefined }, { refresh_token_expires_in: 0 },
  ])("rejects an incomplete or invalid rotating token response %j", async invalid => {
    const client = createHttpShopifyClient(vi.fn(async () => Response.json({ ...payload(), ...invalid })));
    await expect(client.exchangeAuthorizationCode({ ...appCredentials, code: "code" })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("distinguishes revoked credentials from transient failures without exposing provider errors", async () => {
    for (const [status, body, code] of [
      [401, { error: "secret-details" }, "PROVIDER_AUTH_FAILED"],
      [400, { error: "invalid_grant", description: "secret-details" }, "PROVIDER_AUTH_FAILED"],
      [503, { error: "secret-details" }, "PROVIDER_TEMPORARILY_UNAVAILABLE"],
    ] as const) {
      const client = createHttpShopifyClient(vi.fn(async () => Response.json(body, { status })));
      const result = await client.refreshUserToken!({ ...appCredentials, refreshToken: "old" }).catch(error => error);
      expect(result).toMatchObject({ code });
      expect(result.message).not.toContain("secret-details");
    }
  });

  it("honors provider backoff even when a token failure response is not JSON", async () => {
    const client = createHttpShopifyClient(vi.fn(async () => new Response("upstream limited", { status: 429, headers: { "Retry-After": "900" } })));
    await expect(client.refreshUserToken!({ ...appCredentials, refreshToken: "old" })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterSeconds: 900 });
  });
});

describe("Shopify saved authorization lifecycle", () => {
  let harness: TestHarness;
  afterEach(async () => { await harness?.close(); });

  async function boot() {
    harness = await createHarness();
    const userId = await createUser(harness);
    const client = new FakeShopifyClient();
    const runtime: ShopifyOAuthRuntime = { enabled: true, clientId: "shopify-app-id", appCredentialReference: "memory:shopify-app", redirectUri: "https://api.example.test/oauth/shopify/callback", client };
    await harness.credentialStore.put({ adapterKey: "shopify", credentialReference: runtime.appCredentialReference!, material: { clientSecret: "shopify-secret" } });
    const service: ConnectedAccountService = {
      registry: createConnectedAccountRegistry({ ...disabledConnectedAccountRuntimes(disabledEbayRuntime(), harness.credentialStore), shopify: runtime }),
      credentials: harness.credentialStore, packproofEnvironment: "test", webReturnUrl: "/account",
    };
    return { userId, client, runtime, service };
  }

  async function connect(userId: string, service: ConnectedAccountService) {
    const started = await startConnectedAccountConnect(harness.db, harness.clock, userId, "shopify", service, { shop });
    const query = { code: "valid-shopify-code", state: new URL(started.authorizationUrl).searchParams.get("state")!, shop };
    const canonical = Object.keys(query).sort().map(key => `${key}=${query[key as keyof typeof query]}`).join("&");
    const result = await completeConnectedAccountOAuth(harness.db, harness.clock, service, "shopify", {
      ...query, hmac: createHmac("sha256", "shopify-secret").update(canonical).digest("hex"),
    });
    const accountId = (await harness.db.query<{ id: string }>("SELECT id FROM connected_accounts WHERE user_id=$1", [userId])).rows[0]?.id;
    return { result, accountId };
  }

  it("saves access and refresh expiry, rotates once for concurrent stale-token refreshes, and hides token values", async () => {
    const { userId, client, service } = await boot();
    const { accountId, result } = await connect(userId, service);
    expect(result.redirectTo).toContain("connected=shopify");
    const account = await loadConnectedAccount(harness.db, accountId);
    const stored = (await harness.credentialStore.getCredentials({ adapterKey: "shopify", credentialReference: account.credentialReference }))!;
    expect(stored.material).toMatchObject({ accessToken: "shp-access-1", refreshToken: "shp-refresh-1", shop, shopId: "shop-123" });
    expect(Date.parse(stored.material.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(stored.material.refreshTokenExpiresAt)).toBeGreaterThan(Date.parse(stored.material.expiresAt));
    const refreshed = await Promise.all([1, 2].map(() => refreshConnectedAccountCredentials(harness.db, harness.clock, userId, accountId, service, { expectedAccessToken: "shp-access-1", preserveCommerceLease: true })));
    expect(client.tokenSeq).toBe(2);
    expect(JSON.stringify(refreshed)).not.toMatch(/shp-access|shp-refresh/);
    const latest = (await harness.credentialStore.getCredentials({ adapterKey: "shopify", credentialReference: account.credentialReference }))!;
    expect(latest.material).toMatchObject({ accessToken: "shp-access-2", refreshToken: "shp-refresh-2" });
  });

  it("refreshes proactively and retries provider auth only once using the latest token", async () => {
    const { userId, client, service } = await boot();
    const { accountId } = await connect(userId, service);
    const record = await loadConnectedAccount(harness.db, accountId);
    const old = (await harness.credentialStore.getCredentials({ adapterKey: "shopify", credentialReference: record.credentialReference }))!;
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    await harness.credentialStore.put({ ...old, material: { ...old.material, expiresAt: expiredAt } });
    await updateConnectedAccount(harness.db, harness.clock, record.id, { expiresAt: expiredAt });
    const connection = await loadConnection(harness.db, accountId);
    const run = createShopifyAccessTokenRunner(harness.db, harness.clock, service);
    expect(await run(connection, async accessToken => accessToken)).toBe("shp-access-2");
    const seen: string[] = [];
    await run(connection, async accessToken => {
      seen.push(accessToken);
      if (seen.length === 1) throw providerAuthFailed();
      return "ok";
    });
    expect(seen).toEqual(["shp-access-2", "shp-access-3"]);
    expect(client.tokenSeq).toBe(3);
  });

  it("persists rotated reconnect tokens using verified saved identity if the post-exchange identity read is transiently unavailable", async () => {
    const { userId, client, service } = await boot();
    const original = await connect(userId, service);
    vi.spyOn(client, "getShop").mockRejectedValueOnce(providerTemporarilyUnavailable());
    const reconnected = await connect(userId, service);
    expect(reconnected.result.redirectTo).toContain("connected=shopify");
    expect(reconnected.accountId).toBe(original.accountId);
    const account = await loadConnectedAccount(harness.db, original.accountId);
    const stored = (await harness.credentialStore.getCredentials({ adapterKey: "shopify", credentialReference: account.credentialReference }))!;
    expect(stored.material).toMatchObject({ accessToken: "shp-access-2", refreshToken: "shp-refresh-2", shop, shopId: "shop-123" });
  });

  it("preserves credentials on transient refresh failure, persists revoked status, and never revives disconnect", async () => {
    const { userId, client, service } = await boot();
    const { accountId } = await connect(userId, service);
    const refresh = vi.spyOn(client, "refreshUserToken");
    refresh.mockRejectedValueOnce(providerTemporarilyUnavailable());
    await expect(refreshConnectedAccountCredentials(harness.db, harness.clock, userId, accountId, service)).rejects.toMatchObject({ code: "PROVIDER_TEMPORARILY_UNAVAILABLE" });
    expect((await loadConnectedAccount(harness.db, accountId)).status).toBe("CONNECTED");
    refresh.mockRejectedValueOnce(providerAuthFailed());
    await expect(refreshConnectedAccountCredentials(harness.db, harness.clock, userId, accountId, service)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect((await loadConnectedAccount(harness.db, accountId)).status).toBe("NEEDS_REAUTH");
    await disconnectConnectedAccount(harness.db, harness.clock, userId, accountId, service);
    await expect(refreshConnectedAccountCredentials(harness.db, harness.clock, userId, accountId, service)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect((await loadConnectedAccount(harness.db, accountId)).status).toBe("DISCONNECTED");
  });

  it("rejects conflicting shop ownership before token exchange can retire existing credentials", async () => {
    const { userId, client, service } = await boot();
    const original = await connect(userId, service);
    const other = await createUser(harness);
    const { result } = await connect(other, service);
    expect(result.redirectTo).toContain("CONNECTED_ACCOUNT_ALREADY_LINKED");
    expect(client.tokenSeq).toBe(1);
    await disconnectConnectedAccount(harness.db, harness.clock, userId, original.accountId, service);
    const nextOwner = await connect(other, service);
    expect(nextOwner.result.redirectTo).toContain("connected=shopify");
    expect(client.tokenSeq).toBe(2);
    const deniedOldOwner = await connect(userId, service);
    expect(deniedOldOwner.result.redirectTo).toContain("CONNECTED_ACCOUNT_ALREADY_LINKED");
    expect(client.tokenSeq).toBe(2);
    client.tokens.clear();
    const revokedBeforeNotification = client.revoked;
    expect(await handleShopifyAppUninstalled(harness.db, harness.clock, shop, service)).toMatchObject({ disconnected: 1 });
    expect((await loadConnectedAccount(harness.db, nextOwner.accountId)).status).toBe("DISCONNECTED");
    expect(client.revoked).toBe(revokedBeforeNotification);
  });

  it("ignores stale uninstall notifications and retries transient verification without revoking the new installation", async () => {
    const { userId, client, service } = await boot();
    const { accountId } = await connect(userId, service);
    expect(await handleShopifyAppUninstalled(harness.db, harness.clock, shop, service)).toMatchObject({ disconnected: 0 });
    expect(client.revoked).toBe(0);
    const identity = vi.spyOn(client, "getShop");
    identity.mockRejectedValueOnce(providerTemporarilyUnavailable());
    await expect(handleShopifyAppUninstalled(harness.db, harness.clock, shop, service)).rejects.toMatchObject({ code: "PROVIDER_TEMPORARILY_UNAVAILABLE" });
    expect((await loadConnectedAccount(harness.db, accountId)).status).toBe("CONNECTED");
    expect(client.revoked).toBe(0);
    const record = await loadConnectedAccount(harness.db, accountId);
    const stored = (await harness.credentialStore.getCredentials({ adapterKey: "shopify", credentialReference: record.credentialReference }))!;
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    await harness.credentialStore.put({ ...stored, material: { ...stored.material, expiresAt: expiredAt } });
    await updateConnectedAccount(harness.db, harness.clock, accountId, { expiresAt: expiredAt });
    expect(await handleShopifyAppUninstalled(harness.db, harness.clock, shop, service)).toMatchObject({ disconnected: 0 });
    expect(client.tokenSeq).toBe(2);
    expect(client.revoked).toBe(0);
  });

  it("rejects old scopes and lost refresh material instead of treating expiring tokens as permanent", async () => {
    const { userId, runtime, service } = await boot();
    const { accountId } = await connect(userId, service);
    const record = await loadConnectedAccount(harness.db, accountId);
    const stored = (await harness.credentialStore.getCredentials({ adapterKey: "shopify", credentialReference: record.credentialReference }))!;
    const provider = createShopifyConnectedAccountProvider({ runtime, credentials: harness.credentialStore });
    await expect(provider.refreshCredentials({ material: { ...stored.material, refreshToken: "" } })).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    await expect(provider.refreshCredentials({ material: { ...stored.material, scope: "read_orders" } })).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    await expect(provider.refreshCredentials({ material: { ...stored.material, refreshTokenExpiresAt: "2020-01-01T00:00:00Z" } })).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
  });

  it("keeps saved authorization on webhook registration failure and retries with the access runner", async () => {
    const { userId, service } = await boot();
    const sync = vi.fn().mockRejectedValueOnce(providerTemporarilyUnavailable()).mockResolvedValue({ topics: ["orders/create"], subscriptionIds: ["subscription-1"] });
    service.syncShopifyWebhooks = sync;
    const { accountId, result } = await connect(userId, service);
    expect(result.redirectTo).toContain("connected=shopify");
    let record = await loadConnectedAccount(harness.db, accountId);
    expect(record.status).toBe("CONNECTED");
    expect(record.providerMetadata.webhookRegistrationErrorCode).toBe("PROVIDER_TEMPORARILY_UNAVAILABLE");
    const run = createShopifyAccessTokenRunner(harness.db, harness.clock, service);
    const connection = await loadConnection(harness.db, accountId);
    await run(connection, async () => "ok");
    expect(sync).toHaveBeenCalledTimes(1);
    await harness.db.query("UPDATE connected_accounts SET provider_metadata=provider_metadata || $2::jsonb WHERE id=$1", [accountId, JSON.stringify({ webhookRegistrationAttemptedAt: "2020-01-01T00:00:00Z", webhookRegistrationRetryAt: null })]);
    await run(connection, async () => "ok");
    record = await loadConnectedAccount(harness.db, accountId);
    expect(record.providerMetadata.webhookTopics).toEqual(["orders/create"]);
    expect(record.providerMetadata.webhookRegistrationErrorCode).toBeNull();
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
