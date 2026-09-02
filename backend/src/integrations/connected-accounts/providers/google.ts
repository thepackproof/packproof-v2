import { DomainError } from "../../../domain/errors.js";
import { providerAuthFailed, providerResponseInvalid } from "../../../domain/integration-errors.js";
import { asRecord, asString, oauthJson, splitScopes, type FetchLike } from "../http.js";
import { pkceChallengeS256 } from "../pkce.js";
import { parseAppClientSecret } from "../app-secret.js";
import type { ConnectedAccountProvider } from "../types.js";
import type { IntegrationCredentialStore } from "../../credentials.js";

export const GOOGLE_SCOPES = ["openid", "email", "profile"] as const;

export const GOOGLE_CAPABILITIES = {
  identity: true,
  transactions: false,
  fulfillment: false,
  shipping: false,
  webhooks: false,
} as const;

export const GOOGLE_LIMITATIONS = [
  "Google connected accounts use official OIDC/OAuth for identity only.",
  "This is not Cognito sign-in and does not replace PackProof authentication.",
  "Google does not provide marketplace transaction, fulfillment, or shipping APIs used by PackProof.",
];

export interface GoogleOAuthRuntime {
  enabled: boolean;
  clientId: string | null;
  appCredentialReference: string | null;
  redirectUri: string;
  fetchImpl: FetchLike;
}

export function createGoogleConnectedAccountProvider(input: {
  runtime: GoogleOAuthRuntime;
  credentials: IntegrationCredentialStore;
}): ConnectedAccountProvider {
  const { runtime, credentials } = input;
  return {
    provider: "google",
    displayName: "Google",
    capabilities: { ...GOOGLE_CAPABILITIES },
    limitations: [...GOOGLE_LIMITATIONS],
    isEnabled() {
      return Boolean(runtime.enabled && runtime.clientId && runtime.appCredentialReference);
    },
    oauthPurpose() {
      return "link";
    },
    callbackRedirectUri() {
      return runtime.redirectUri;
    },
    async getAuthorizationUrl(input) {
      requireEnabled(runtime);
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", runtime.clientId!);
      url.searchParams.set("redirect_uri", runtime.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
      url.searchParams.set("state", input.state);
      url.searchParams.set("code_challenge", pkceChallengeS256(input.codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "false");
      return { authorizationUrl: url.toString(), redirectUri: runtime.redirectUri };
    },
    async handleCallback(input) {
      requireEnabled(runtime);
      const tokens = await exchangeGoogleToken(runtime, credentials, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: runtime.redirectUri,
        code_verifier: input.codeVerifier ?? undefined,
      });
      const identity = await googleUserInfo(runtime, tokens.accessToken);
      return { tokens, identity };
    },
    async refreshCredentials(input) {
      requireEnabled(runtime);
      const refreshToken = input.material.refreshToken?.trim();
      if (!refreshToken) {
        throw providerAuthFailed();
      }
      const refreshed = await exchangeGoogleToken(runtime, credentials, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      return {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? refreshToken,
      };
    },
    async getAccountIdentity(input) {
      requireEnabled(runtime);
      return googleUserInfo(runtime, input.accessToken);
    },
    async disconnect(input) {
      const token = input.material.refreshToken?.trim() || input.material.accessToken?.trim();
      if (!token) {
        return;
      }
      try {
        await runtime.fetchImpl("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        });
      } catch {
        // Best-effort revoke.
      }
    },
  };
}

async function exchangeGoogleToken(
  runtime: GoogleOAuthRuntime,
  credentials: IntegrationCredentialStore,
  body: Record<string, string | undefined>,
) {
  requireEnabled(runtime);
  const clientSecret = parseAppClientSecret(
    await credentials.getCredentials({
      adapterKey: "google",
      credentialReference: runtime.appCredentialReference,
    }),
  );
  const params = new URLSearchParams({
    client_id: runtime.clientId,
    client_secret: clientSecret,
  });
  for (const [key, value] of Object.entries(body)) {
    if (value) {
      params.set(key, value);
    }
  }
  const payload = await oauthJson(runtime.fetchImpl, {
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  const record = asRecord(payload);
  const accessToken = asString(record.access_token);
  if (!accessToken) {
    throw providerResponseInvalid();
  }
  const expiresIn = Number(record.expires_in);
  return {
    accessToken,
    refreshToken: asString(record.refresh_token),
    tokenType: asString(record.token_type) ?? "Bearer",
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null,
    scopes: (() => {
      const scopes = splitScopes(asString(record.scope));
      return scopes.length > 0 ? scopes : [...GOOGLE_SCOPES];
    })(),
  };
}

async function googleUserInfo(runtime: GoogleOAuthRuntime, accessToken: string) {
  const payload = await oauthJson(runtime.fetchImpl, {
    url: "https://openidconnect.googleapis.com/v1/userinfo",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const record = asRecord(payload);
  const sub = asString(record.sub);
  if (!sub) {
    throw providerResponseInvalid();
  }
  return {
    externalAccountId: sub,
    externalAccountName: asString(record.name) ?? asString(record.email),
    metadata: {
      email: asString(record.email),
      emailVerified: record.email_verified === true,
    },
  };
}

function requireEnabled(
  runtime: GoogleOAuthRuntime,
): asserts runtime is GoogleOAuthRuntime & { clientId: string; appCredentialReference: string } {
  if (!runtime.enabled || !runtime.clientId || !runtime.appCredentialReference) {
    throw new DomainError("CONNECTED_ACCOUNT_PROVIDER_DISABLED", "Google is not enabled", 403);
  }
}

export function disabledGoogleRuntime(): GoogleOAuthRuntime {
  return {
    enabled: false,
    clientId: null,
    appCredentialReference: null,
    redirectUri: "http://127.0.0.1:3000/oauth/google/callback",
    fetchImpl: fetch,
  };
}
