import { DomainError } from "../../../domain/errors.js";
import { providerAuthFailed, providerResponseInvalid } from "../../../domain/integration-errors.js";
import { asNumber, asRecord, asString, oauthJson, splitScopes, type FetchLike } from "../http.js";
import { parseAppClientSecret } from "../app-secret.js";
import type { ConnectedAccountProvider } from "../types.js";
import type { IntegrationCredentialStore } from "../../credentials.js";

export const FACEBOOK_GRAPH_VERSION = "v21.0";
export const FACEBOOK_SCOPES = ["public_profile"] as const;

export const FACEBOOK_CAPABILITIES = {
  identity: true,
  transactions: false,
  fulfillment: false,
  shipping: false,
  webhooks: false,
} as const;

export const FACEBOOK_LIMITATIONS = [
  "Meta/Facebook connected accounts use official Facebook Login / Graph API identity only.",
  "Facebook Marketplace has no official public API for C2C listings or transactions. PackProof does not fabricate Marketplace order import.",
  "This is not Cognito sign-in and does not replace PackProof authentication.",
  "Instagram/Facebook Shops Catalog Commerce APIs are out of this slice.",
];

export interface FacebookOAuthRuntime {
  enabled: boolean;
  appId: string | null;
  appCredentialReference: string | null;
  redirectUri: string;
  fetchImpl: FetchLike;
}

export function createFacebookConnectedAccountProvider(input: {
  runtime: FacebookOAuthRuntime;
  credentials: IntegrationCredentialStore;
}): ConnectedAccountProvider {
  const { runtime, credentials } = input;
  return {
    provider: "facebook",
    displayName: "Meta",
    capabilities: { ...FACEBOOK_CAPABILITIES },
    limitations: [...FACEBOOK_LIMITATIONS],
    isEnabled() {
      return Boolean(runtime.enabled && runtime.appId && runtime.appCredentialReference);
    },
    oauthPurpose() {
      return "link";
    },
    callbackRedirectUri() {
      return runtime.redirectUri;
    },
    async getAuthorizationUrl(input) {
      requireEnabled(runtime);
      const url = new URL(`https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`);
      url.searchParams.set("client_id", runtime.appId!);
      url.searchParams.set("redirect_uri", runtime.redirectUri);
      url.searchParams.set("state", input.state);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", FACEBOOK_SCOPES.join(","));
      return { authorizationUrl: url.toString(), redirectUri: runtime.redirectUri };
    },
    async handleCallback(input) {
      requireEnabled(runtime);
      const shortLived = await facebookToken(runtime, credentials, {
        client_id: runtime.appId,
        redirect_uri: runtime.redirectUri,
        code: input.code,
      });
      const longLived = await exchangeLongLived(runtime, credentials, shortLived.accessToken).catch(
        () => shortLived,
      );
      const identity = await facebookMe(runtime, longLived.accessToken);
      return { tokens: longLived, identity };
    },
    async refreshCredentials(input) {
      requireEnabled(runtime);
      const token = input.material.accessToken?.trim();
      if (!token) {
        throw providerAuthFailed();
      }
      const longLived = await exchangeLongLived(runtime, credentials, token);
      return longLived;
    },
    async getAccountIdentity(input) {
      requireEnabled(runtime);
      return facebookMe(runtime, input.accessToken);
    },
    async disconnect(input) {
      const token = input.material.accessToken?.trim();
      if (!token) {
        return;
      }
      try {
        await runtime.fetchImpl(
          `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me/permissions?access_token=${encodeURIComponent(token)}`,
          { method: "DELETE" },
        );
      } catch {
        // Best-effort revoke.
      }
    },
  };
}

async function facebookToken(
  runtime: FacebookOAuthRuntime,
  credentials: IntegrationCredentialStore,
  params: Record<string, string>,
) {
  requireEnabled(runtime);
  const appSecret = parseAppClientSecret(
    await credentials.getCredentials({
      adapterKey: "facebook",
      credentialReference: runtime.appCredentialReference,
    }),
  );
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set("client_id", runtime.appId);
  url.searchParams.set("client_secret", appSecret);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const payload = await oauthJson(runtime.fetchImpl, {
    url: url.toString(),
    headers: { Accept: "application/json" },
  });
  const record = asRecord(payload);
  const accessToken = asString(record.access_token);
  if (!accessToken) {
    throw providerResponseInvalid();
  }
  const expiresIn = asNumber(record.expires_in);
  return {
    accessToken,
    refreshToken: null,
    tokenType: asString(record.token_type) ?? "bearer",
    expiresAt: expiresIn != null ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    scopes: splitScopes(asString(record.scope)) || [...FACEBOOK_SCOPES],
  };
}

async function exchangeLongLived(
  runtime: FacebookOAuthRuntime,
  credentials: IntegrationCredentialStore,
  token: string,
) {
  requireEnabled(runtime);
  return facebookToken(runtime, credentials, {
    grant_type: "fb_exchange_token",
    fb_exchange_token: token,
  });
}

async function facebookMe(runtime: FacebookOAuthRuntime, accessToken: string) {
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me`);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("access_token", accessToken);
  const payload = await oauthJson(runtime.fetchImpl, {
    url: url.toString(),
    headers: { Accept: "application/json" },
  });
  const record = asRecord(payload);
  const id = asString(record.id);
  if (!id) {
    throw providerResponseInvalid();
  }
  return {
    externalAccountId: id,
    externalAccountName: asString(record.name),
    metadata: {},
  };
}

function requireEnabled(
  runtime: FacebookOAuthRuntime,
): asserts runtime is FacebookOAuthRuntime & { appId: string; appCredentialReference: string } {
  if (!runtime.enabled || !runtime.appId || !runtime.appCredentialReference) {
    throw new DomainError("CONNECTED_ACCOUNT_PROVIDER_DISABLED", "Meta is not enabled", 403);
  }
}

export function disabledFacebookRuntime(): FacebookOAuthRuntime {
  return {
    enabled: false,
    appId: null,
    appCredentialReference: null,
    redirectUri: "http://127.0.0.1:3000/oauth/facebook/callback",
    fetchImpl: fetch,
  };
}
