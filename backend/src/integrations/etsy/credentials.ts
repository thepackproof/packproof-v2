import { DomainError } from "../../domain/errors.js";
import type { IntegrationCredentials } from "../credentials.js";

export function parseEtsySharedSecret(credentials: IntegrationCredentials | null): string {
  const secret = credentials?.material.sharedSecret?.trim() || credentials?.material.clientSecret?.trim() || credentials?.material.apiKey?.trim();
  if (!secret || !/^[A-Za-z0-9_-]{8,256}$/.test(secret)) {
    throw new DomainError("ETSY_APPLICATION_NOT_CONFIGURED", "PackProof's Etsy application credentials are missing or unavailable. The server connection setup needs attention.", 503);
  }
  return secret;
}
