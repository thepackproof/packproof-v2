import { integrationCredentialReference } from "../secrets-manager-credential-store.js";
import type { OAuthTokenSet } from "./types.js";

export function connectedAccountCredentialReference(input: {
  packproofEnvironment: string;
  provider: string;
  accountId: string;
}): string {
  return integrationCredentialReference({
    packproofEnvironment: input.packproofEnvironment,
    adapterKey: input.provider,
    connectionId: input.accountId,
  });
}

export function tokenMaterial(tokens: OAuthTokenSet): Record<string, string> {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? "",
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt ?? "",
    scope: tokens.scopes.join(" "),
    ...(tokens.extraMaterial ?? {}),
  };
}

export function scopesFromMaterial(material: Record<string, string>): string[] {
  return (material.scope ?? "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}
