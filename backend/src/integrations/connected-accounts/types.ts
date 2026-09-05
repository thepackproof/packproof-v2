import type { ConnectedAccountProviderId, OAuthAttemptPurpose } from "../../domain/identity-providers.js";

export const CONNECTED_ACCOUNT_STATUSES = [
  "CONNECTED",
  "NEEDS_REAUTH",
  "DISCONNECTED",
  "ERROR",
] as const;

export type ConnectedAccountStatus = (typeof CONNECTED_ACCOUNT_STATUSES)[number];

export interface ProviderCapabilities {
  identity: boolean;
  transactions: boolean;
  fulfillment: boolean;
  shipping: boolean;
  webhooks: boolean;
}

export interface AccountIdentity {
  externalAccountId: string;
  externalAccountName: string | null;
  metadata: Record<string, unknown>;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  scopes: string[];
  extraMaterial?: Record<string, string>;
}

export interface AuthorizationStartInput {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  extra?: Record<string, unknown>;
}

export interface CallbackInput {
  code: string;
  codeVerifier: string | null;
  redirectUri: string | null;
  extra?: Record<string, unknown>;
}

export interface ConnectedAccountProvider {
  readonly provider: ConnectedAccountProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly limitations: string[];
  isEnabled(): boolean;
  oauthPurpose(): OAuthAttemptPurpose;
  callbackRedirectUri(): string;
  verifyCallback?(query: Record<string, unknown>): Promise<void>;
  getAuthorizationUrl(input: AuthorizationStartInput): Promise<{
    authorizationUrl: string;
    redirectUri: string;
  }>;
  handleCallback(input: CallbackInput): Promise<{ tokens: OAuthTokenSet; identity: AccountIdentity }>;
  refreshCredentials(input: { material: Record<string, string> }): Promise<OAuthTokenSet>;
  getAccountIdentity(input: {
    accessToken: string;
    extra?: Record<string, unknown>;
  }): Promise<AccountIdentity>;
  disconnect(input: { material: Record<string, string> }): Promise<void>;
}

export function emptyCapabilities(): ProviderCapabilities {
  return {
    identity: false,
    transactions: false,
    fulfillment: false,
    shipping: false,
    webhooks: false,
  };
}
