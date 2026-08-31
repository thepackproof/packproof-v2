import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { IntegrationCredentialStore, IntegrationCredentials } from "./credentials.js";

export class SecretsManagerCredentialStore implements IntegrationCredentialStore {
  constructor(private readonly client: SecretsManagerClient) {}

  async getCredentials(input: {
    adapterKey: string;
    credentialReference: string;
  }): Promise<IntegrationCredentials | null> {
    const secretId = secretIdFromReference(input.credentialReference);
    if (!secretId) {
      return null;
    }
    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const raw = result.SecretString;
      if (!raw) {
        return null;
      }
      const material = parseSecretString(raw);
      if (!material) {
        return null;
      }
      return {
        adapterKey: input.adapterKey,
        credentialReference: input.credentialReference,
        material,
      };
    } catch {
      return null;
    }
  }
}

export function secretIdFromReference(reference: string): string | null {
  if (reference.startsWith("arn:aws:secretsmanager:")) {
    return reference;
  }
  if (reference.startsWith("sm:")) {
    const rest = reference.slice(3).trim();
    return rest || null;
  }
  if (reference.startsWith("packproof/")) {
    return reference;
  }
  return null;
}

export function looksLikeSecretId(reference: string): boolean {
  return secretIdFromReference(reference) !== null;
}

function parseSecretString(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { apiKey: raw };
    }
    const material: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        material[key] = value;
      }
    }
    return material;
  } catch {
    return { apiKey: raw };
  }
}

export function createSecretsManagerClient(region: string): SecretsManagerClient {
  return new SecretsManagerClient({ region });
}
