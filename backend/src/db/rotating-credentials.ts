import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DomainError } from "../domain/errors.js";

export function databaseUnavailable(): DomainError {
  return new DomainError(
    "DATABASE_UNAVAILABLE",
    "PackProof cannot access saved records right now. Please retry shortly. This is a service issue, not a problem with your password.",
    503,
  );
}

/** Resolve AWSCURRENT for every new physical connection, not once at boot.
 * Never cache passwords across connections or replay a database operation.
 * Existing authenticated connections remain usable during RDS rotation.
 */
export function createDatabasePasswordProvider(input: {
  secretId: string;
  region: string;
  expectedUsername: string;
  readSecret?: () => Promise<{ SecretString?: string }>;
}): () => Promise<string> {
  if (!input.secretId.trim() || !input.region.trim() || !input.expectedUsername) {
    throw new Error("Rotating database credentials require a secret, region, and configured username");
  }
  const client = input.readSecret ? null : new SecretsManagerClient({ region: input.region });
  const readSecret = input.readSecret ?? (() => client!.send(
    new GetSecretValueCommand({ SecretId: input.secretId, VersionStage: "AWSCURRENT" }),
    { abortSignal: AbortSignal.timeout(10_000) },
  ));
  return async () => {
    try {
      const result = await readSecret();
      if (!result.SecretString) throw databaseUnavailable();
      const value: unknown = JSON.parse(result.SecretString);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw databaseUnavailable();
      const credentials = value as Record<string, unknown>;
      if (credentials.username !== input.expectedUsername ||
          typeof credentials.password !== "string" || !credentials.password) {
        throw databaseUnavailable();
      }
      return credentials.password;
    } catch {
      // Do not expose AWS errors, secret identifiers, JSON, or credential values.
      throw databaseUnavailable();
    }
  };
}
