import { DomainError } from "../../../domain/errors.js";
import type { EbayRuntime } from "../../../domain/ebay-marketplace.js";
import { parseEbayAppSecret } from "../../ebay/credentials.js";
import { EBAY_SCOPES } from "../../ebay/constants.js";
import { buildEbayAuthorizationUrl } from "../../ebay/oauth.js";
import { ebayAccountReference } from "../../ebay/normalize.js";
import { splitScopes } from "../http.js";
import type { ConnectedAccountProvider, OAuthTokenSet } from "../types.js";
import type { IntegrationCredentialStore } from "../../credentials.js";

export const EBAY_CONNECTED_CAPABILITIES = {
  identity: true,
  transactions: true,
  fulfillment: true,
  shipping: false,
  webhooks: true,
} as const;

export const EBAY_CONNECTED_LIMITATIONS = [
  "eBay is a connected marketplace, not a PackProof sign-in identity.",
  "Seller Sell Fulfillment order import is supported through the existing eBay marketplace path.",
  "Buyer purchase import is not implemented.",
  "Dedicated carrier shipping APIs are not part of the eBay connection.",
];

export function createEbayConnectedAccountProvider(input: {
  runtime: EbayRuntime;
  credentials: IntegrationCredentialStore;
}): ConnectedAccountProvider {
  const { runtime, credentials } = input;
  return {
    provider: "ebay",
    displayName: "eBay",
    capabilities: { ...EBAY_CONNECTED_CAPABILITIES },
    limitations: [...EBAY_CONNECTED_LIMITATIONS],
    isEnabled() {
      return Boolean(
        runtime.enabled && runtime.client && runtime.clientId && runtime.ruName && runtime.appCredentialReference,
      );
    },
    oauthPurpose() {
      return "marketplace_connect";
    },
    callbackRedirectUri() {
      return runtime.ruName ?? "";
    },
    async getAuthorizationUrl(start) {
      requireEbay(runtime);
      return {
        authorizationUrl: buildEbayAuthorizationUrl({
          environment: runtime.environment,
          clientId: runtime.clientId,
          ruName: runtime.ruName,
          state: start.state,
        }),
        redirectUri: runtime.ruName,
      };
    },
    async handleCallback(callback) {
      requireEbay(runtime);
      const appSecret = parseEbayAppSecret(
        await credentials.getCredentials({
          adapterKey: "ebay",
          credentialReference: runtime.appCredentialReference,
        }),
      );
      const tokens = await runtime.client.exchangeAuthorizationCode({
        environment: runtime.environment,
        clientId: runtime.clientId,
        clientSecret: appSecret,
        ruName: runtime.ruName,
        code: callback.code,
      });
      const identity = await runtime.client.getUser({
        environment: runtime.environment,
        accessToken: tokens.accessToken,
      });
      const mapped = toTokenSet(tokens);
      mapped.extraMaterial = {
        ebayUserId: identity.userId,
        ebayUsername: identity.username ?? "",
        environment: runtime.environment,
      };
      return {
        tokens: mapped,
        identity: {
          externalAccountId: ebayAccountReference(identity.userId, identity.username),
          externalAccountName: identity.username,
          metadata: {
            ebayUserId: identity.userId,
            ebayUsername: identity.username,
            environment: runtime.environment,
          },
        },
      };
    },
    async refreshCredentials(stored) {
      requireEbay(runtime);
      const refreshToken = stored.material.refreshToken?.trim();
      if (!refreshToken) {
        throw new DomainError("INTEGRATION_NEEDS_REAUTH", "eBay refresh token is missing", 409);
      }
      const appSecret = parseEbayAppSecret(
        await credentials.getCredentials({
          adapterKey: "ebay",
          credentialReference: runtime.appCredentialReference!,
        }),
      );
      const tokens = await runtime.client.refreshUserToken({
        environment: runtime.environment,
        clientId: runtime.clientId,
        clientSecret: appSecret,
        refreshToken,
      });
      const mapped = toTokenSet(tokens);
      mapped.extraMaterial = {
        ebayUserId: stored.material.ebayUserId ?? "",
        ebayUsername: stored.material.ebayUsername ?? "",
        environment: runtime.environment,
      };
      return mapped;
    },
    async getAccountIdentity(identityInput) {
      requireEbay(runtime);
      const identity = await runtime.client.getUser({
        environment: runtime.environment,
        accessToken: identityInput.accessToken,
      });
      return {
        externalAccountId: ebayAccountReference(identity.userId, identity.username),
        externalAccountName: identity.username,
        metadata: {
          ebayUserId: identity.userId,
          ebayUsername: identity.username,
          environment: runtime.environment,
        },
      };
    },
    async disconnect(stored) {
      const token = stored.material.refreshToken?.trim() || stored.material.accessToken?.trim();
      if (!token || !runtime.client || typeof runtime.client.revokeUserToken !== "function") {
        return;
      }
      try {
        const appSecret = parseEbayAppSecret(
          await credentials.getCredentials({
            adapterKey: "ebay",
            credentialReference: runtime.appCredentialReference ?? "",
          }),
        );
        await runtime.client.revokeUserToken({
          environment: runtime.environment,
          clientId: runtime.clientId ?? "",
          clientSecret: appSecret,
          token,
        });
      } catch {
        // Best-effort revoke.
      }
    },
  };
}

function toTokenSet(tokens: {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresInSeconds: number;
  scope: string | null;
}): OAuthTokenSet {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
    scopes: splitScopes(tokens.scope) || [...EBAY_SCOPES],
  };
}

function requireEbay(
  runtime: EbayRuntime,
): asserts runtime is EbayRuntime & {
  client: NonNullable<EbayRuntime["client"]>;
  clientId: string;
  ruName: string;
  appCredentialReference: string;
} {
  if (!runtime.enabled || !runtime.client || !runtime.clientId || !runtime.ruName || !runtime.appCredentialReference) {
    throw new DomainError("CONNECTED_ACCOUNT_PROVIDER_DISABLED", "eBay is not enabled", 403);
  }
}
