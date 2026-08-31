import { providerAuthFailed, providerResponseInvalid } from "../../domain/integration-errors.js";
import type { IntegrationCredentials } from "../credentials.js";

export type EasyPostCredentialMode = "test" | "production";

export interface EasyPostCredentials {
  apiKey: string;
  webhookSecret: string | null;
  mode: EasyPostCredentialMode;
}

const PRODUCTION_KEY_PREFIX = "EZAK";

export function parseEasyPostCredentials(credentials: IntegrationCredentials): EasyPostCredentials {
  const apiKey = credentials.material.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw providerAuthFailed();
  }
  const mode = parseMode(credentials.material.mode);
  if (mode === "test" && apiKey.toUpperCase().startsWith(PRODUCTION_KEY_PREFIX)) {
    throw providerAuthFailed();
  }
  const webhookSecret = credentials.material.webhookSecret?.trim() || null;
  return { apiKey, webhookSecret, mode };
}

function parseMode(value: string | undefined): EasyPostCredentialMode {
  if (value == null || value.trim() === "" || value.trim().toLowerCase() === "test") {
    return "test";
  }
  if (value.trim().toLowerCase() === "production") {
    return "production";
  }
  throw providerResponseInvalid();
}
