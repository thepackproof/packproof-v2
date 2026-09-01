import { DomainError } from "./errors.js";

export const AUTH_IDENTITY_PROVIDERS = [
  "cognito",
  "dev",
  "google",
  "facebook",
  "tiktok",
  "x",
] as const;

export const MARKETPLACE_PROVIDERS = ["ebay"] as const;

export type AuthIdentityProvider = (typeof AUTH_IDENTITY_PROVIDERS)[number];
export type MarketplaceProvider = (typeof MARKETPLACE_PROVIDERS)[number];
export type OAuthAttemptPurpose = "authenticate" | "link" | "marketplace_connect";

const AUTH_PROVIDER_SET = new Set<string>(AUTH_IDENTITY_PROVIDERS);
const MARKETPLACE_PROVIDER_SET = new Set<string>(MARKETPLACE_PROVIDERS);

export function isAuthIdentityProvider(value: string): value is AuthIdentityProvider {
  return AUTH_PROVIDER_SET.has(value);
}

export function isMarketplaceProvider(value: string): value is MarketplaceProvider {
  return MARKETPLACE_PROVIDER_SET.has(value);
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
  const provider = value.trim().toLowerCase();
  if (isAuthIdentityProvider(provider) || isMarketplaceProvider(provider)) {
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
