import { DomainError } from "../../domain/errors.js";
import type { IntegrationCredentials } from "../credentials.js";

export function parseAppClientSecret(credentials: IntegrationCredentials | null): string {
  const secret =
    credentials?.material.clientSecret?.trim() ||
    credentials?.material.appSecret?.trim() ||
    credentials?.material.apiKey?.trim() ||
    "";
  if (!secret) {
    throw new DomainError(
      "INTEGRATION_CREDENTIALS_UNAVAILABLE",
      "Application credentials are not configured",
      503,
    );
  }
  return secret;
}
