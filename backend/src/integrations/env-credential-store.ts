import type { IntegrationCredentialStore, IntegrationCredentials } from "./credentials.js";

function envName(credentialReference: string): string | null {
  if (credentialReference.startsWith("env:")) {
    return credentialReference.slice(4);
  }
  return null;
}

export class EnvCredentialStore implements IntegrationCredentialStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getCredentials(input: {
    adapterKey: string;
    credentialReference: string;
  }): Promise<IntegrationCredentials | null> {
    const name = envName(input.credentialReference);
    if (!name) {
      return null;
    }
    const raw = this.env[name];
    if (!raw) {
      return null;
    }
    const material = parseMaterial(raw);
    if (!material) {
      return null;
    }
    return {
      adapterKey: input.adapterKey,
      credentialReference: input.credentialReference,
      material,
    };
  }
}

function parseMaterial(raw: string): Record<string, string> | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const material: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") {
          material[key] = value;
        }
      }
      return material;
    } catch {
      return null;
    }
  }
  return { apiKey: trimmed };
}
