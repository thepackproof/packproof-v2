import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DomainError } from "../domain/errors.js";
import type {
  IntegrationCredentials,
  MutableCredentialStore,
} from "./credentials.js";

export type SecretsManagerSendClient = {
  send(command: unknown): Promise<unknown>;
};

export class SecretsManagerCredentialStore implements MutableCredentialStore {
  constructor(private readonly client: SecretsManagerSendClient) {}

  async getCredentials(input: {
    adapterKey: string;
    credentialReference: string;
  }): Promise<IntegrationCredentials | null> {
    const secretId = secretIdFromReference(input.credentialReference);
    if (!secretId) {
      return null;
    }
    try {
      const result = (await this.client.send(new GetSecretValueCommand({ SecretId: secretId }))) as {
        SecretString?: string;
      };
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

  async put(credentials: IntegrationCredentials): Promise<void> {
    const secretId = secretIdFromReference(credentials.credentialReference);
    if (!secretId) {
      throw unavailable();
    }
    const secretString = JSON.stringify(credentials.material);
    try {
      await this.client.send(
        new PutSecretValueCommand({
          SecretId: secretId,
          SecretString: secretString,
        }),
      );
    } catch (error) {
      if (!isAwsErrorName(error, "ResourceNotFoundException")) {
        throw unavailable();
      }
      try {
        await this.client.send(
          new CreateSecretCommand({
            Name: secretId,
            SecretString: secretString,
            Description: `PackProof ${credentials.adapterKey} integration credentials`,
          }),
        );
      } catch (createError) {
        if (isAwsErrorName(createError, "ResourceExistsException")) {
          await this.client.send(
            new PutSecretValueCommand({
              SecretId: secretId,
              SecretString: secretString,
            }),
          );
          return;
        }
        throw unavailable();
      }
    }
  }

  async deleteCredentials(input: {
    adapterKey: string;
    credentialReference: string;
  }): Promise<void> {
    const secretId = secretIdFromReference(input.credentialReference);
    if (!secretId) {
      return;
    }
    try {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: secretId,
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (error) {
      if (isAwsErrorName(error, "ResourceNotFoundException")) {
        return;
      }
      throw unavailable();
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

export function integrationCredentialReference(input: {
  packproofEnvironment: string;
  adapterKey: string;
  connectionId: string;
  suffix?: string;
}): string {
  const environment = secretNameSegment(input.packproofEnvironment, "development");
  const adapter = secretNameSegment(input.adapterKey, "integration");
  const connectionId = secretNameSegment(input.connectionId, "connection");
  const suffix = input.suffix ? `/${secretNameSegment(input.suffix, "default")}` : "";
  return `packproof/${environment}/integrations/${adapter}${suffix}/${connectionId}`;
}

function secretNameSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
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

function isAwsErrorName(error: unknown, name: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { name?: string; Code?: string };
  return record.name === name || record.Code === name;
}

function unavailable(): DomainError {
  return new DomainError(
    "INTEGRATION_CREDENTIALS_UNAVAILABLE",
    "Trusted integration credentials are unavailable",
    503,
  );
}

export function createSecretsManagerClient(region: string): SecretsManagerClient {
  return new SecretsManagerClient({ region });
}
