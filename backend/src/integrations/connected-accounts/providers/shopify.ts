import { DomainError } from "../../../domain/errors.js";
import type { ShopifyClient } from "../../shopify/types.js";
import {
  SHOPIFY_CAPABILITIES,
  SHOPIFY_LIMITATIONS,
  SHOPIFY_SCOPES,
  SHOPIFY_PROVIDER,
  shopifyAuthorizeUrl,
} from "../../shopify/constants.js";
import { normalizeShopifyShop } from "../../shopify/shop.js";
import { splitScopes } from "../http.js";
import { parseAppClientSecret } from "../app-secret.js";
import type { ConnectedAccountProvider } from "../types.js";
import type { IntegrationCredentialStore } from "../../credentials.js";

export interface ShopifyOAuthRuntime {
  enabled: boolean;
  clientId: string | null;
  appCredentialReference: string | null;
  redirectUri: string;
  client: ShopifyClient | null;
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
    async getAuthorizationUrl(start) {
      requireEnabled(runtime);
      const shop = normalizeShopifyShop(start.extra?.shop);
      const url = new URL(shopifyAuthorizeUrl(shop));
      url.searchParams.set("client_id", runtime.clientId);
      url.searchParams.set("scope", SHOPIFY_SCOPES.join(","));
      url.searchParams.set("redirect_uri", runtime.redirectUri);
      url.searchParams.set("state", start.state);
      url.searchParams.set("grant_options[]", "offline");
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
      const identity = await runtime.client.getShop({
        shop,
        accessToken: tokens.accessToken,
      });
      const scopes = splitScopes(tokens.scope);
      return {
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: null,
          tokenType: "offline",
          expiresAt: null,
          scopes: scopes.length > 0 ? scopes : [...SHOPIFY_SCOPES],
          extraMaterial: { shop: identity.myshopifyDomain, shopId: identity.shopId },
        },
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
      const identity = await runtime.client.getShop({ shop, accessToken });
      return {
        accessToken,
        refreshToken: null,
        tokenType: "offline",
        expiresAt: null,
        scopes: splitScopes(stored.material.scope),
        extraMaterial: { shop: identity.myshopifyDomain, shopId: identity.shopId },
      };
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
