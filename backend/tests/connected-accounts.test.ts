import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { refreshConnectedAccountCredentials } from "../src/domain/connected-accounts.js";
import { listAccountAudit } from "../src/domain/account-audit.js";
import { createConnectedAccountRegistry } from "../src/integrations/connected-accounts/runtime.js";
import { createDefaultIntegrationRegistry } from "../src/integrations/registry.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";
import { FakeEbayClient } from "./fixtures/ebay.js";
import {
  FakeShopifyClient,
  facebookScriptedFetch,
  googleScriptedFetch,
} from "./fixtures/connected-accounts.js";
import { shopifyWebhookHmac } from "../src/integrations/shopify/hmac.js";
import { systemClock } from "../src/clock.js";
import type { EbayRuntime } from "../src/domain/ebay-marketplace.js";
import type { ShopifyOAuthRuntime } from "../src/integrations/connected-accounts/providers/shopify.js";
import type { GoogleOAuthRuntime } from "../src/integrations/connected-accounts/providers/google.js";
import type { FacebookOAuthRuntime } from "../src/integrations/connected-accounts/providers/facebook.js";

const SECRETS = [
  "test-cert-id",
  "shopify-secret",
  "google-secret",
  "facebook-secret",
];

function ebayRuntime(client: FakeEbayClient): EbayRuntime {
  return {
    enabled: true,
    packproofEnvironment: "test",
    environment: "sandbox",
    clientId: "ebay-app-id",
    ruName: "PackProof-RuName-1",
    marketplaceId: "EBAY_US",
    appCredentialReference: "memory:ebay-app",
    deletionVerificationToken: "deletion-token",
    deletionEndpoint: "https://api.packproof.test/integrations/webhooks/ebay/account-deletion",
    webReturnUrl: "http://127.0.0.1:5173/stores",
    client,
  };
}

function shopifyRuntime(client: FakeShopifyClient): ShopifyOAuthRuntime {
  return {
    enabled: true,
    clientId: "shopify-app-id",
    appCredentialReference: "memory:shopify-app",
    redirectUri: "http://127.0.0.1/oauth/shopify/callback",
    client,
  };
}

function googleRuntime(fetchImpl = googleScriptedFetch()): GoogleOAuthRuntime {
  return {
    enabled: true,
    clientId: "google-client-id",
    appCredentialReference: "memory:google-app",
    redirectUri: "http://127.0.0.1/oauth/google/callback",
    fetchImpl,
  };
}

function facebookRuntime(fetchImpl = facebookScriptedFetch()): FacebookOAuthRuntime {
  return {
    enabled: true,
    appId: "facebook-app-id",
    appCredentialReference: "memory:facebook-app",
    redirectUri: "http://127.0.0.1/oauth/facebook/callback",
    fetchImpl,
  };
}

async function seedAppSecrets(harness: TestHarness): Promise<void> {
  await harness.credentialStore.put({
    adapterKey: "ebay",
    credentialReference: "memory:ebay-app",
    material: { clientSecret: "test-cert-id" },
  });
  await harness.credentialStore.put({
    adapterKey: "shopify",
    credentialReference: "memory:shopify-app",
    material: { clientSecret: "shopify-secret" },
  });
  await harness.credentialStore.put({
    adapterKey: "google",
    credentialReference: "memory:google-app",
    material: { clientSecret: "google-secret" },
  });
  await harness.credentialStore.put({
    adapterKey: "facebook",
    credentialReference: "memory:facebook-app",
    material: { clientSecret: "facebook-secret" },
  });
}

async function connectProvider(
  harness: TestHarness,
  userId: string,
  provider: string,
  code: string,
  body: Record<string, unknown> = {},
): Promise<{ accountId: string; location: string }> {
  const started = await request(harness.app)
    .post(`/me/connected-accounts/${provider}/connect`)
    .set(auth(userId))
    .send(body);
  expect(started.status).toBe(201);
  expect(started.body.authorizationUrl).toBeTruthy();
  expect(JSON.stringify(started.body)).not.toMatch(/secret|token|verifier/i);
  const url = new URL(started.body.authorizationUrl);
  const callbackPath = provider === "ebay" ? "/oauth/ebay/callback" : `/oauth/${provider}/callback`;
  const callback = await request(harness.app).get(callbackPath).query({
    code,
    state: url.searchParams.get("state"),
    shop: typeof body.shop === "string" ? body.shop : undefined,
  });
  expect(callback.status).toBe(302);
  const location = String(callback.headers.location);
  expect(location).toMatch(/connected=|ebay=connected/);
  const listed = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
  expect(listed.status).toBe(200);
  const account = listed.body.accounts.find((row: { provider: string }) => row.provider === (provider === "meta" ? "facebook" : provider));
  expect(account).toBeTruthy();
  return { accountId: account.id as string, location };
}

describe("connected account configuration", () => {
  it("keeps provider app secrets off AppConfig", () => {
    const config = loadConfig({
      PACKPROOF_GOOGLE_CLIENT_ID: "public-google",
      PACKPROOF_GOOGLE_CLIENT_SECRET: "google-secret-value",
      PACKPROOF_FACEBOOK_APP_ID: "public-facebook",
      PACKPROOF_FACEBOOK_APP_SECRET: "facebook-secret-value",
      PACKPROOF_SHOPIFY_CLIENT_ID: "public-shopify",
      PACKPROOF_SHOPIFY_CLIENT_SECRET: "shopify-secret-value",
    });
    expect(config.google.enabled).toBe(false);
    expect(config.facebook.enabled).toBe(false);
    expect(config.shopify.enabled).toBe(false);
    expect(JSON.stringify(config)).not.toContain("google-secret-value");
    expect(JSON.stringify(config)).not.toContain("facebook-secret-value");
    expect(JSON.stringify(config)).not.toContain("shopify-secret-value");
  });

  it("fails closed when a provider is enabled without credentials", () => {
    expect(() =>
      loadConfig({ PACKPROOF_GOOGLE_INTEGRATION_ENABLED: "true", PACKPROOF_GOOGLE_CLIENT_ID: "x" }),
    ).toThrow(/PACKPROOF_GOOGLE_CLIENT_SECRET/);
    expect(() =>
      loadConfig({ PACKPROOF_FACEBOOK_INTEGRATION_ENABLED: "true", PACKPROOF_FACEBOOK_APP_ID: "x" }),
    ).toThrow(/PACKPROOF_FACEBOOK_APP_SECRET/);
    expect(() =>
      loadConfig({ PACKPROOF_SHOPIFY_INTEGRATION_ENABLED: "true", PACKPROOF_SHOPIFY_CLIENT_ID: "x" }),
    ).toThrow(/PACKPROOF_SHOPIFY_CLIENT_SECRET/);
  });
});

describe("connected accounts", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  async function boot(options: {
    ebay?: FakeEbayClient;
    shopify?: FakeShopifyClient;
    googleFetch?: ReturnType<typeof googleScriptedFetch>;
    facebookFetch?: ReturnType<typeof facebookScriptedFetch>;
  } = {}) {
    const shopifyClient = options.shopify ?? new FakeShopifyClient();
    harness = await createHarness(undefined, {
      ebay: ebayRuntime(options.ebay ?? new FakeEbayClient()),
      shopify: shopifyRuntime(shopifyClient),
      google: googleRuntime(options.googleFetch ?? googleScriptedFetch()),
      facebook: facebookRuntime(options.facebookFetch ?? facebookScriptedFetch()),
      integrations: createDefaultIntegrationRegistry(systemClock, { shopifyClient }),
    });
    await seedAppSecrets(harness);
    return { shopifyClient };
  }

  it("lists provider capabilities without tokens when nothing is connected", async () => {
    await boot();
    const userId = await login(harness.app, "seller-1");
    const listed = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
    expect(listed.status).toBe(200);
    expect(listed.body.accounts).toEqual([]);
    const providers = listed.body.providers.map((row: { provider: string }) => row.provider).sort();
    expect(providers).toEqual(["ebay", "facebook", "google", "shopify"]);
    const google = listed.body.providers.find((row: { provider: string }) => row.provider === "google");
    expect(google.capabilities).toEqual({
      identity: true,
      transactions: false,
      fulfillment: false,
      shipping: false,
      webhooks: false,
    });
    const shopify = listed.body.providers.find((row: { provider: string }) => row.provider === "shopify");
    expect(shopify.requiresShop).toBe(true);
    expect(shopify.multipleAccounts).toBe(true);
    const facebook = listed.body.providers.find((row: { provider: string }) => row.provider === "facebook");
    expect(facebook.capabilities.transactions).toBe(false);
    expect(facebook.limitations.join(" ")).toMatch(/Marketplace has no official public API/i);
    expect(JSON.stringify(listed.body)).not.toMatch(/token|secret|client_secret/i);
  });

  it("rejects connect when the provider is disabled", async () => {
    harness = await createHarness();
    const userId = await login(harness.app, "seller-1");
    const started = await request(harness.app)
      .post("/me/connected-accounts/google/connect")
      .set(auth(userId));
    expect(started.status).toBe(403);
    expect(started.body.error.code).toBe("CONNECTED_ACCOUNT_PROVIDER_DISABLED");
  });

  describe("eBay", () => {
    it("builds an official authorize URL with CSRF state and no client secret", async () => {
      await boot();
      const userId = await login(harness.app, "seller-1");
      const started = await request(harness.app)
        .post("/me/connected-accounts/ebay/connect")
        .set(auth(userId));
      expect(started.status).toBe(201);
      const url = new URL(started.body.authorizationUrl);
      expect(url.origin).toBe("https://auth.sandbox.ebay.com");
      expect(url.searchParams.get("client_id")).toBe("ebay-app-id");
      expect(url.searchParams.get("state")).toBeTruthy();
      expect(started.body.authorizationUrl).not.toContain("test-cert-id");
      expect(started.body.authorizationUrl).not.toContain("client_secret");
    });

    it("persists identity and encrypted credentials, then disconnects and revokes", async () => {
      const ebay = new FakeEbayClient();
      await boot({ ebay });
      const userId = await login(harness.app, "seller-1");
      const connected = await connectProvider(harness, userId, "ebay", "valid-ebay-code");
      const listed = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
      expect(listed.body.accounts[0]).toMatchObject({
        provider: "ebay",
        status: "CONNECTED",
        capabilities: { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: true },
      });
      expect(JSON.stringify(listed.body)).not.toContain("test-cert-id");
      expect(JSON.stringify(listed.body)).not.toContain("access-");
      const stored = await harness.credentialStore.getCredentials({
        adapterKey: "ebay",
        credentialReference: (
          await harness.db.query<{ credential_reference: string }>(
            `SELECT credential_reference FROM connected_accounts WHERE id = $1`,
            [connected.accountId],
          )
        ).rows[0]!.credential_reference,
      });
      expect(stored?.material.accessToken).toMatch(/^access-/);
      expect(stored?.material.refreshToken).toBeTruthy();

      const invalid = await request(harness.app).get("/oauth/ebay/callback").query({
        code: "valid-ebay-code",
        state: "missing",
      });
      expect(invalid.headers.location).toContain("OAUTH_STATE_INVALID");

      const disconnected = await request(harness.app)
        .delete(`/me/connected-accounts/${connected.accountId}`)
        .set(auth(userId));
      expect(disconnected.status).toBe(204);
      expect(ebay.revoked).toBeGreaterThan(0);
      const after = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
      expect(after.body.accounts).toEqual([]);
      expect(
        await harness.credentialStore.getCredentials({
          adapterKey: "ebay",
          credentialReference: stored!.credentialReference,
        }),
      ).toBeNull();
      const audits = await listAccountAudit(harness.db, userId);
      expect(audits.map((row) => row.eventType)).toEqual(
        expect.arrayContaining(["CONNECTED_ACCOUNT_LINKED", "CONNECTED_ACCOUNT_DISCONNECTED"]),
      );
      expect(JSON.stringify(audits)).not.toMatch(/access-|refresh-/);
    });

    it("refreshes eBay user tokens without returning them", async () => {
      const ebay = new FakeEbayClient();
      await boot({ ebay });
      const userId = await login(harness.app, "seller-1");
      const connected = await connectProvider(harness, userId, "ebay", "valid-ebay-code");
      const service = {
        registry: createConnectedAccountRegistry({
          ebay: ebayRuntime(ebay),
          shopify: shopifyRuntime(new FakeShopifyClient()),
          google: googleRuntime(),
          facebook: facebookRuntime(),
          credentials: harness.credentialStore,
        }),
        credentials: harness.credentialStore,
        packproofEnvironment: "test",
        webReturnUrl: "/account",
      };
      const refreshed = await refreshConnectedAccountCredentials(
        harness.db,
        harness.clock,
        userId,
        connected.accountId,
        service,
      );
      expect(refreshed.status).toBe("CONNECTED");
      expect(JSON.stringify(refreshed)).not.toMatch(/access-|refresh-/);
    });
  });

  describe("Shopify", () => {
    it("requires a myshopify shop and persists shop identity", async () => {
      const { shopifyClient } = await boot();
      const userId = await login(harness.app, "seller-1");
      const missing = await request(harness.app)
        .post("/me/connected-accounts/shopify/connect")
        .set(auth(userId))
        .send({});
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe("INVALID_SHOP_DOMAIN");

      const started = await request(harness.app)
        .post("/me/connected-accounts/shopify/connect")
        .set(auth(userId))
        .send({ shop: "https://PackProof-Test.myshopify.com/admin" });
      expect(started.status).toBe(201);
      const url = new URL(started.body.authorizationUrl);
      expect(url.origin).toBe("https://packproof-test.myshopify.com");
      expect(url.searchParams.get("client_id")).toBe("shopify-app-id");
      expect(url.searchParams.get("scope")).toContain("read_orders");
      expect(started.body.authorizationUrl).not.toContain("shopify-secret");

      const connected = await connectProvider(harness, userId, "shopify", "valid-shopify-code", {
        shop: "packproof-test.myshopify.com",
      });
      const listed = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
      expect(listed.body.accounts[0]).toMatchObject({
        provider: "shopify",
        externalAccountId: "packproof-test.myshopify.com",
        externalAccountName: "PackProof Test Shop",
        status: "CONNECTED",
        capabilities: { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: true },
      });
      expect(JSON.stringify(listed.body)).not.toContain("shp-access-");

      const commerce = await request(harness.app)
        .get("/me/integration-connections?capability=commerce")
        .set(auth(userId));
      const shopifyConn = commerce.body.connections.find((row: { provider: string }) => row.provider === "shopify");
      expect(shopifyConn).toBeTruthy();

      const synced = await request(harness.app)
        .post(`/me/commerce-connections/${shopifyConn.connectionId}/sync`)
        .set(auth(userId))
        .send({});
      expect(synced.status).toBe(200);
      expect(synced.body.discoveredCount).toBeGreaterThan(0);
      expect(JSON.stringify(synced.body)).not.toContain("shp-access-");

      await request(harness.app).delete(`/me/connected-accounts/${connected.accountId}`).set(auth(userId));
      expect(shopifyClient.revoked).toBeGreaterThan(0);
    });

    it("disconnects on a verified app/uninstalled webhook", async () => {
      await boot();
      const userId = await login(harness.app, "seller-1");
      await connectProvider(harness, userId, "shopify", "valid-shopify-code", {
        shop: "packproof-test.myshopify.com",
      });
      const raw = "{}";
      const hmac = shopifyWebhookHmac("shopify-secret", Buffer.from(raw, "utf8"));
      const webhook = await request(harness.app)
        .post("/integrations/webhooks/shopify")
        .set("X-Shopify-Topic", "app/uninstalled")
        .set("X-Shopify-Shop-Domain", "packproof-test.myshopify.com")
        .set("X-Shopify-Hmac-Sha256", hmac)
        .set("Content-Type", "application/json")
        .send(raw);
      expect(webhook.status).toBe(200);
      const listed = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
      expect(listed.body.accounts).toEqual([]);
    });
  });

  describe("Google", () => {
    it("uses OIDC with PKCE and does not treat Cognito as this integration", async () => {
      await boot();
      const userId = await login(harness.app, "seller-1");
      const started = await request(harness.app)
        .post("/me/connected-accounts/google/connect")
        .set(auth(userId));
      expect(started.status).toBe(201);
      const url = new URL(started.body.authorizationUrl);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("scope")).toBe("openid email profile");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(started.body.authorizationUrl).not.toContain("google-secret");

      const first = await request(harness.app).get("/oauth/google/callback").query({
        code: "valid-google-code",
        state: url.searchParams.get("state"),
      });
      expect(first.status).toBe(302);
      expect(first.headers.location).toContain("connected=google");
      const listed = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
      expect(listed.body.accounts[0]).toMatchObject({
        provider: "google",
        externalAccountId: "google-sub-001",
        externalAccountName: "Collin Google",
        capabilities: { identity: true, transactions: false, fulfillment: false, shipping: false, webhooks: false },
      });
      const accountId = listed.body.accounts[0].id as string;
      const identities = await request(harness.app).get("/me/identities").set(auth(userId));
      expect(identities.body.identities.some((row: { provider: string }) => row.provider === "google")).toBe(false);

      const reused = await request(harness.app).get("/oauth/google/callback").query({
        code: "valid-google-code",
        state: url.searchParams.get("state"),
      });
      expect(reused.headers.location).toMatch(/OAUTH_STATE_REUSED|OAUTH_STATE_INVALID|error/);

      const service = {
        registry: createConnectedAccountRegistry({
          ebay: ebayRuntime(new FakeEbayClient()),
          shopify: shopifyRuntime(new FakeShopifyClient()),
          google: googleRuntime(),
          facebook: facebookRuntime(),
          credentials: harness.credentialStore,
        }),
        credentials: harness.credentialStore,
        packproofEnvironment: "test",
        webReturnUrl: "/account",
      };
      const refreshed = await refreshConnectedAccountCredentials(
        harness.db,
        harness.clock,
        userId,
        accountId,
        service,
      );
      expect(refreshed.status).toBe("CONNECTED");
      expect(JSON.stringify(refreshed)).not.toContain("google-access-");

      const reauth = await request(harness.app)
        .post(`/me/connected-accounts/${accountId}/reauthorize`)
        .set(auth(userId));
      expect(reauth.status).toBe(201);
      expect(reauth.body.authorizationUrl).toContain("accounts.google.com");
    });

    it("records AUTH_ERROR and does not persist tokens on a bad callback", async () => {
      await boot();
      const userId = await login(harness.app, "seller-1");
      const started = await request(harness.app)
        .post("/me/connected-accounts/google/connect")
        .set(auth(userId));
      const url = new URL(started.body.authorizationUrl);
      const callback = await request(harness.app).get("/oauth/google/callback").query({
        code: "bad-google-code",
        state: url.searchParams.get("state"),
      });
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toContain("connected=error");
      const listed = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
      expect(listed.body.accounts).toEqual([]);
      const audits = await listAccountAudit(harness.db, userId);
      expect(audits.some((row) => row.eventType === "CONNECTED_ACCOUNT_AUTH_ERROR")).toBe(true);
    });
  });

  describe("Meta/Facebook", () => {
    it("links Graph identity only and accepts the meta alias", async () => {
      await boot();
      const userId = await login(harness.app, "seller-1");
      const started = await request(harness.app)
        .post("/me/connected-accounts/meta/connect")
        .set(auth(userId));
      expect(started.status).toBe(201);
      const url = new URL(started.body.authorizationUrl);
      expect(url.hostname).toBe("www.facebook.com");
      expect(url.searchParams.get("scope")).toBe("public_profile");
      expect(started.body.authorizationUrl).not.toContain("facebook-secret");

      const callback = await request(harness.app).get("/oauth/facebook/callback").query({
        code: "valid-facebook-code",
        state: url.searchParams.get("state"),
      });
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toContain("connected=facebook");
      const listed = await request(harness.app).get("/me/connected-accounts").set(auth(userId));
      expect(listed.body.accounts[0]).toMatchObject({
        provider: "facebook",
        providerDisplay: "Meta",
        externalAccountId: "fb-user-001",
        externalAccountName: "Collin Meta",
        capabilities: { identity: true, transactions: false, fulfillment: false, shipping: false, webhooks: false },
      });
      expect(listed.body.accounts[0].limitations.join(" ")).toMatch(/does not fabricate Marketplace/i);
      expect(JSON.stringify(listed.body)).not.toContain("facebook-access-");
      expect(JSON.stringify(listed.body)).not.toContain("facebook-secret");
    });
  });

  it("does not leak secrets through error payloads", async () => {
    await boot();
    const userId = await login(harness.app, "seller-1");
    const started = await request(harness.app).post("/me/connected-accounts/google/connect").set(auth(userId));
    const callback = await request(harness.app).get("/oauth/google/callback").query({
      error: "access_denied",
      state: new URL(started.body.authorizationUrl).searchParams.get("state"),
    });
    expect(JSON.stringify(callback.headers)).not.toMatch(/google-secret|google-access/);
    for (const secret of SECRETS) {
      expect(JSON.stringify(callback.body ?? {})).not.toContain(secret);
    }
  });
});
