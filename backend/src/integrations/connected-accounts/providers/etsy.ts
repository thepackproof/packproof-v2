import { DomainError } from "../../../domain/errors.js";
import type { IntegrationCredentialStore } from "../../credentials.js";
import { etsyUserIdFromToken } from "../../etsy/client.js";
import { ETSY_AUTHORIZATION_URL, ETSY_SCOPES } from "../../etsy/constants.js";
import { parseEtsySharedSecret } from "../../etsy/credentials.js";
import type { EtsyRuntime } from "../../etsy/runtime.js";
import type { EtsyShopIdentity, EtsyTokenSet } from "../../etsy/types.js";
import { pkceChallengeS256 } from "../pkce.js";
import type { AccountIdentity, ConnectedAccountProvider, OAuthTokenSet } from "../types.js";

export const ETSY_CONNECTED_CAPABILITIES = { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: false } as const;
export const ETSY_CONNECTED_LIMITATIONS = [
  "Etsy is a connected seller shop, not a PackProof sign-in identity.",
  "Automatic checks import paid, unshipped physical orders. Split shipments, mixed digital orders and refunded orders need separate handling.",
  "PackProof reads orders only; it does not mark Etsy orders shipped, buy labels or contact buyers.",
  "Etsy must approve the application and the shop owner must authorize access before synchronization can start.",
];

export function createEtsyConnectedAccountProvider(input: { runtime: EtsyRuntime; credentials: IntegrationCredentialStore }): ConnectedAccountProvider {
  const { runtime, credentials } = input;
  const client = () => {
    if (!runtime.enabled || !runtime.client || !runtime.clientId || !runtime.appCredentialReference) {
      throw new DomainError("CONNECTED_ACCOUNT_PROVIDER_DISABLED", "Etsy is not enabled on this PackProof server.", 403);
    }
    return runtime.client;
  };
  return {
    provider: "etsy", displayName: "Etsy", capabilities: { ...ETSY_CONNECTED_CAPABILITIES }, limitations: [...ETSY_CONNECTED_LIMITATIONS],
    isEnabled: () => Boolean(runtime.enabled && runtime.client && runtime.clientId && runtime.appCredentialReference),
    oauthPurpose: () => "marketplace_connect",
    callbackRedirectUri: () => runtime.redirectUri,
    async getAuthorizationUrl(start) {
      client();
      // Check setup before sending the seller away; a login cannot repair missing app credentials.
      parseEtsySharedSecret(await credentials.getCredentials({ adapterKey: "etsy", credentialReference: runtime.appCredentialReference! }));
      requireRedirect(runtime.redirectUri);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(start.codeVerifier) || !start.state.trim()) throw new DomainError("INVALID_OAUTH_STATE", "Etsy authorization state is invalid.", 400);
      const url = new URL(ETSY_AUTHORIZATION_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", runtime.clientId!);
      url.searchParams.set("redirect_uri", runtime.redirectUri);
      url.searchParams.set("scope", ETSY_SCOPES.join(" "));
      url.searchParams.set("state", start.state);
      url.searchParams.set("code_challenge", pkceChallengeS256(start.codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
      return { authorizationUrl: url.toString(), redirectUri: runtime.redirectUri };
    },
    async handleCallback(callback) {
      const api = client();
      requireRedirect(runtime.redirectUri);
      if (callback.redirectUri !== runtime.redirectUri || !callback.codeVerifier) throw new DomainError("INVALID_OAUTH_STATE", "The Etsy callback does not match the authorization attempt.", 400);
      const tokens = await api.exchangeAuthorizationCode({ code: callback.code, codeVerifier: callback.codeVerifier, redirectUri: runtime.redirectUri });
      requireScopes(tokens.scopes ?? [...ETSY_SCOPES]);
      const shop = await api.getShop({ accessToken: tokens.accessToken });
      return { tokens: tokenSet(tokens, shop), identity: accountIdentity(shop) };
    },
    async refreshCredentials(stored) {
      const api = client();
      const shopId = stored.material.etsyShopId;
      const userId = stored.material.etsyUserId;
      if (!shopId || !userId || !stored.material.refreshToken || etsyUserIdFromToken(stored.material.refreshToken) !== userId) throw needsReauth();
      const previousScopes = (stored.material.scope ?? "").split(/\s+/).filter(Boolean);
      requireScopes(previousScopes);
      const tokens = await api.refreshUserToken({ refreshToken: stored.material.refreshToken });
      if (etsyUserIdFromToken(tokens.accessToken) !== userId) throw needsReauth();
      return tokenSet({ ...tokens, scopes: tokens.scopes ?? previousScopes }, { shopId, userId, shopName: stored.material.etsyShopName || "Etsy shop" });
    },
    async getAccountIdentity(value) { return accountIdentity(await client().getShop({ accessToken: value.accessToken })); },
    async disconnect() {
      // Etsy's public v3 API has no documented OAuth revocation endpoint. The shared
      // connected-account disconnect removes the stored credentials and stops polling.
    },
  };
}

function tokenSet(tokens: EtsyTokenSet, shop: EtsyShopIdentity): OAuthTokenSet {
  const scopes = tokens.scopes ?? [...ETSY_SCOPES];
  requireScopes(scopes);
  if (etsyUserIdFromToken(tokens.accessToken) !== shop.userId) throw needsReauth();
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, tokenType: tokens.tokenType,
    expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(), scopes,
    extraMaterial: { etsyShopId: shop.shopId, etsyUserId: shop.userId, etsyShopName: shop.shopName } };
}
function accountIdentity(shop: EtsyShopIdentity): AccountIdentity {
  return { externalAccountId: shop.shopId, externalAccountName: shop.shopName,
    metadata: { etsyShopId: shop.shopId, etsyUserId: shop.userId, etsyShopName: shop.shopName, environment: "production" } };
}
function requireScopes(scopes: string[]): void { if (!ETSY_SCOPES.every(scope => scopes.includes(scope))) throw needsReauth(); }
function needsReauth(): DomainError { return new DomainError("INTEGRATION_NEEDS_REAUTH", "Reconnect Etsy and allow shop and order read access.", 409); }
function requireRedirect(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError("ETSY_APPLICATION_NOT_CONFIGURED", "The Etsy callback URL is not configured.", 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new DomainError("ETSY_APPLICATION_NOT_CONFIGURED", "Etsy requires an exact registered HTTPS callback URL.", 503);
}
