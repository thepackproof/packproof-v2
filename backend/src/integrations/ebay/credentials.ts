import { DomainError } from "../../domain/errors.js";
import {
  providerAuthFailed,
  providerRateLimited,
  providerResponseInvalid,
  providerTemporarilyUnavailable,
} from "../../domain/integration-errors.js";
import type { IntegrationCredentials } from "../credentials.js";

export function parseEbayAppSecret(credentials: IntegrationCredentials | null): string {
  const secret =
    credentials?.material.clientSecret?.trim() ||
    credentials?.material.apiKey?.trim() ||
    "";
  if (!secret) {
    throw new DomainError(
      "INTEGRATION_CREDENTIALS_UNAVAILABLE",
      "eBay application credentials are not configured",
      503,
    );
  }
  return secret;
}

export function ebayUserCredentialMaterial(input: {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
  ebayUserId: string;
  ebayUsername: string | null;
  environment: string;
}): Record<string, string> {
  return {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenType: input.tokenType,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? "",
    scope: input.scope ?? "",
    ebayUserId: input.ebayUserId,
    ebayUsername: input.ebayUsername ?? "",
    environment: input.environment,
  };
}

export function parseEbayUserCredentials(credentials: IntegrationCredentials | null): {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  ebayUserId: string;
  ebayUsername: string | null;
} {
  if (!credentials) {
    throw providerAuthFailed();
  }
  const accessToken = credentials.material.accessToken?.trim() ?? "";
  const refreshToken = credentials.material.refreshToken?.trim() ?? "";
  if (!accessToken || !refreshToken) {
    throw providerAuthFailed();
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: credentials.material.accessTokenExpiresAt?.trim() ?? "",
    ebayUserId: credentials.material.ebayUserId?.trim() ?? "",
    ebayUsername: credentials.material.ebayUsername?.trim() || null,
  };
}

export function mapEbayHttpError(status: number): never {
  if (status === 401 || status === 403) {
    throw providerAuthFailed();
  }
  if (status === 429) {
    throw providerRateLimited();
  }
  if (status >= 500) {
    throw providerTemporarilyUnavailable();
  }
  throw providerResponseInvalid();
}
