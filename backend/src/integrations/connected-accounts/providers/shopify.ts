import { DomainError } from "../../../domain/errors.js";
import type { ShopifyClient, ShopifyTokenSet } from "../../shopify/types.js";
import {
  SHOPIFY_CAPABILITIES,
  SHOPIFY_LIMITATIONS,
  SHOPIFY_SCOPES,
  SHOPIFY_PROVIDER,
  shopifyAuthorizeUrl,
} from "../../shopify/constants.js";
import { normalizeShopifyShop } from "../../shopify/shop.js";
import { verifyShopifyOAuthHmac } from "../../shopify/hmac.js";
import { asRecord, asString, splitScopes } from "../http.js";
import { parseAppClientSecret } from "../app-secret.js";
import type { ConnectedAccountProvider, OAuthTokenSet } from "../types.js";
import type { IntegrationCredentialStore } from "../../credentials.js";

export interface ShopifyOAuthRuntime {
  enabled: boolean;
  clientId: string | null;
  appCredentialReference: string | null;
  redirectUri: string;
  client: ShopifyClient | null;
  syncWebhooks?: (input: { shop: string; accessToken: string; scopes: readonly string[] }) => Promise<{ topics: string[]; subscriptionIds: string[] }>;
}

export function createShopifyConnectedAccountProvider(input: {
  runtime: ShopifyOAuthRuntime;
  credentials: IntegrationCredentialStore;
}): ConnectedAccountProvider {
  const { runtime, credentials } = input;
  return {
    provider: SHOPIFY_PROVIDER,
    displayName: "Shopify",
    capabilities: { ...SHOPIFY_CAPABILITIES },
    limitations: [...SHOPIFY_LIMITATIONS],
    isEnabled() {
      return Boolean(runtime.enabled && runtime.clientId && runtime.appCredentialReference && runtime.client);
    },
    oauthPurpose() {
      return "marketplace_connect";
    },
    callbackRedirectUri() {
      return runtime.redirectUri;
    },
    async verifyCallback(query) {
      requireEnabled(runtime);
      const secret = parseAppClientSecret(await credentials.getCredentials({
        adapterKey: SHOPIFY_PROVIDER,
        credentialReference: runtime.appCredentialReference,
      }));
      verifyShopifyOAuthHmac(secret, query);
    },
    async getAuthorizationUrl(start) {
      requireEnabled(runtime);
      const shop = normalizeShopifyShop(start.extra?.shop);
      const url = new URL(shopifyAuthorizeUrl(shop));
      url.searchParams.set("client_id", runtime.clientId);
      url.searchParams.set("scope", SHOPIFY_SCOPES.join(","));
      url.searchParams.set("redirect_uri", runtime.redirectUri);
      url.searchParams.set("state", start.state);
      // Offline is Shopify's default; grant_options[]=per-user selects online.
      return { authorizationUrl: url.toString(), redirectUri: runtime.redirectUri };
    },
    async handleCallback(callback) {
      requireEnabled(runtime);
      const shop = normalizeShopifyShop(callback.extra?.shop);
      const clientSecret = parseAppClientSecret(
        await credentials.getCredentials({
          adapterKey: SHOPIFY_PROVIDER,
          credentialReference: runtime.appCredentialReference,
        }),
      );
      const tokens = await runtime.client.exchangeAuthorizationCode({
        shop,
        clientId: runtime.clientId,
        clientSecret,
        code: callback.code,
      });
      let identity;
      try {
        identity = await runtime.client.getShop({ shop, accessToken: tokens.accessToken });
      } catch (error) {
        const known = asRecord(callback.extra?.verifiedShopIdentity);
        if (!(error instanceof DomainError) || !["PROVIDER_TEMPORARILY_UNAVAILABLE", "PROVIDER_RATE_LIMITED"].includes(error.code) ||
            known.myshopifyDomain !== shop || !asString(known.shopId)) throw error;
        // Acquiring a new offline token retires the prior refresh token. Keep
        // the verified reconnect usable when this optional identity read fails.
        identity = { shopId: asString(known.shopId)!, myshopifyDomain: shop, name: asString(known.name), email: null };
      }
      const scopes = splitScopes(tokens.scope);
      requireShopifyScopes(scopes);
      return {
        tokens: tokenSet(tokens, identity.myshopifyDomain, identity.shopId),
        identity: {
          externalAccountId: identity.myshopifyDomain,
          externalAccountName: identity.name,
          metadata: {
            shopId: identity.shopId,
            myshopifyDomain: identity.myshopifyDomain,
          },
        },
      };
    },
    async refreshCredentials(stored) {
      requireEnabled(runtime);
      const shop = normalizeShopifyShop(stored.material.shop);
      const accessToken = stored.material.accessToken?.trim();
      if (!accessToken) {
        throw new DomainError("INTEGRATION_NEEDS_REAUTH", "Shopify access token is missing", 409);
      }
      const scopes = splitScopes(stored.material.scope);
      requireShopifyScopes(scopes);
      const refreshToken = stored.material.refreshToken?.trim();
      if (!refreshToken) {
        // Non-expiring credentials can still be valid for legacy/custom apps.
        // An expiring token without its refresh token can never be renewed.
        if (stored.material.expiresAt) throw needsReauth();
        const identity = await runtime.client.getShop({ shop, accessToken });
        return tokenSet({ accessToken, scope: scopes.join(",") }, identity.myshopifyDomain, identity.shopId);
      }
      const refreshExpiry = Date.parse(stored.material.refreshTokenExpiresAt ?? "");
      if (!Number.isFinite(refreshExpiry) || refreshExpiry <= Date.now() || !runtime.client.refreshUserToken) throw needsReauth();
      const clientSecret = parseAppClientSecret(await credentials.getCredentials({
        adapterKey: SHOPIFY_PROVIDER, credentialReference: runtime.appCredentialReference,
      }));
      const tokens = await runtime.client.refreshUserToken({ shop, clientId: runtime.clientId, clientSecret, refreshToken });
      // The refresh grant is already bound to the authenticated shop. Persist
      // rotated credentials before making unrelated provider reads that may fail.
      return tokenSet({ ...tokens, scope: tokens.scope || scopes.join(",") }, shop, stored.material.shopId);
    },
    async getAccountIdentity(identityInput) {
      requireEnabled(runtime);
      const shop = normalizeShopifyShop(identityInput.extra?.shop);
      const identity = await runtime.client.getShop({
        shop,
        accessToken: identityInput.accessToken,
      });
      return {
        externalAccountId: identity.myshopifyDomain,
        externalAccountName: identity.name,
        metadata: { shopId: identity.shopId, myshopifyDomain: identity.myshopifyDomain },
      };
    },
    async disconnect(stored) {
      if (!runtime.client) {
        return;
      }
      const shop = stored.material.shop?.trim();
      const accessToken = stored.material.accessToken?.trim();
      if (!shop || !accessToken) {
        return;
      }
      try {
        await runtime.client.revoke({ shop, accessToken });
      } catch {
        // Token may already be invalid; PackProof still deletes stored credentials.
      }
    },
  };
}

function tokenSet(tokens: ShopifyTokenSet, shop: string, shopId: string): OAuthTokenSet {
  const scopes = splitScopes(tokens.scope);
  requireShopifyScopes(scopes);
  const now = Date.now();
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
    tokenType: "offline",
    expiresAt: tokens.expiresInSeconds === undefined ? null : new Date(now + tokens.expiresInSeconds * 1_000).toISOString(),
    scopes,
    extraMaterial: {
      shop, shopId,
      ...(tokens.refreshTokenExpiresInSeconds === undefined ? {} : {
        refreshTokenExpiresAt: new Date(now + tokens.refreshTokenExpiresInSeconds * 1_000).toISOString(),
      }),
    },
  };
}

export function requireShopifyScopes(scopes: readonly string[]): void {
  if (!SHOPIFY_SCOPES.every(scope => scopes.includes(scope) || scopes.includes(scope.replace(/^read_/, "write_")))) {
    throw needsReauth();
  }
}

function needsReauth(): DomainError {
  return new DomainError("INTEGRATION_NEEDS_REAUTH", "Reconnect Shopify and allow order, merchant fulfillment and location access", 409);
}

function requireEnabled(
  runtime: ShopifyOAuthRuntime,
): asserts runtime is ShopifyOAuthRuntime & {
  clientId: string;
  appCredentialReference: string;
  client: ShopifyClient;
} {
  if (!runtime.enabled || !runtime.clientId || !runtime.appCredentialReference || !runtime.client) {
    throw new DomainError("CONNECTED_ACCOUNT_PROVIDER_DISABLED", "Shopify is not enabled", 403);
  }
}

export function disabledShopifyRuntime(): ShopifyOAuthRuntime {
  return {
    enabled: false,
    clientId: null,
    appCredentialReference: null,
    redirectUri: "http://127.0.0.1:3000/oauth/shopify/callback",
    client: null,
  };
}
