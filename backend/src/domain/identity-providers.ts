import { DomainError } from "./errors.js";

export const AUTH_IDENTITY_PROVIDERS = [
  "cognito",
  "dev",
  "google",
  "facebook",
  "tiktok",
  "x",
] as const;

export const MARKETPLACE_PROVIDERS = ["ebay", "shopify"] as const;

export const CONNECTED_ACCOUNT_PROVIDERS = ["ebay", "shopify", "google", "facebook"] as const;

export type AuthIdentityProvider = (typeof AUTH_IDENTITY_PROVIDERS)[number];
export type MarketplaceProvider = (typeof MARKETPLACE_PROVIDERS)[number];
export type ConnectedAccountProviderId = (typeof CONNECTED_ACCOUNT_PROVIDERS)[number];
export type OAuthAttemptPurpose = "authenticate" | "link" | "marketplace_connect";

const AUTH_PROVIDER_SET = new Set<string>(AUTH_IDENTITY_PROVIDERS);
const MARKETPLACE_PROVIDER_SET = new Set<string>(MARKETPLACE_PROVIDERS);
const CONNECTED_ACCOUNT_PROVIDER_SET = new Set<string>(CONNECTED_ACCOUNT_PROVIDERS);
const CONNECTED_ACCOUNT_ALIASES: Record<string, ConnectedAccountProviderId> = {
  meta: "facebook",
  fb: "facebook",
};

export function isAuthIdentityProvider(value: string): value is AuthIdentityProvider {
  return AUTH_PROVIDER_SET.has(value);
}

export function isMarketplaceProvider(value: string): value is MarketplaceProvider {
  return MARKETPLACE_PROVIDER_SET.has(value);
}

export function isConnectedAccountProvider(value: string): value is ConnectedAccountProviderId {
  return CONNECTED_ACCOUNT_PROVIDER_SET.has(value);
}

export function requireConnectedAccountProvider(value: unknown): ConnectedAccountProviderId {
  if (typeof value !== "string") {
    throw new DomainError("INVALID_IDENTITY_PROVIDER", "provider is required", 400);
  }
  const raw = value.trim().toLowerCase();
  const provider = CONNECTED_ACCOUNT_ALIASES[raw] ?? raw;
  if (!isConnectedAccountProvider(provider)) {
    throw new DomainError("INVALID_IDENTITY_PROVIDER", "Unsupported connected-account provider", 400);
  }
  return provider;
}

export function requireAuthIdentityProvider(value: unknown): AuthIdentityProvider {
  if (typeof value !== "string" || !isAuthIdentityProvider(value.trim().toLowerCase())) {
    throw new DomainError("INVALID_IDENTITY_PROVIDER", "Unsupported identity provider", 400);
  }
  return value.trim().toLowerCase() as AuthIdentityProvider;
}

export function requireOAuthProvider(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("INVALID_IDENTITY_PROVIDER", "provider is required", 400);
  }
  const provider = CONNECTED_ACCOUNT_ALIASES[value.trim().toLowerCase()] ?? value.trim().toLowerCase();
  if (
    isAuthIdentityProvider(provider) ||
    isMarketplaceProvider(provider) ||
    isConnectedAccountProvider(provider)
  ) {
    return provider;
  }
  throw new DomainError("INVALID_IDENTITY_PROVIDER", "Unsupported OAuth provider", 400);
}

export function requireOAuthPurpose(value: unknown): OAuthAttemptPurpose {
  if (value === "authenticate" || value === "link" || value === "marketplace_connect") {
    return value;
  }
  throw new DomainError("INVALID_OAUTH_PURPOSE", "OAuth purpose is invalid", 400);
}
