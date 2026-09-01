import type { AppConfig } from "../config.js";
import type { IntegrationCredentials, MutableCredentialStore } from "./credentials.js";
import { EnvCredentialStore } from "./env-credential-store.js";
import { MemoryCredentialStore } from "./memory-credential-store.js";
import {
  createSecretsManagerClient,
  looksLikeSecretId,
  SecretsManagerCredentialStore,
} from "./secrets-manager-credential-store.js";

export class CompositeCredentialStore implements MutableCredentialStore {
  constructor(
    readonly memory: MemoryCredentialStore,
    private readonly env: EnvCredentialStore,
    private readonly secrets?: MutableCredentialStore,
  ) {}

  async put(credentials: IntegrationCredentials): Promise<void> {
    this.memory.put(credentials);
    if (this.secrets && looksLikeSecretId(credentials.credentialReference)) {
      await this.secrets.put(credentials);
    }
  }

  async getCredentials(input: {
    adapterKey: string;
    credentialReference: string;
    connectionId?: string;
  }): Promise<IntegrationCredentials | null> {
    const fromMemory = await this.memory.getCredentials(input);
    if (fromMemory) {
      return fromMemory;
    }
    const fromEnv = await this.env.getCredentials(input);
    if (fromEnv) {
      return fromEnv;
    }
    if (!this.secrets) {
      return null;
    }
    return this.secrets.getCredentials(input);
  }

  async deleteCredentials(input: {
    adapterKey: string;
    credentialReference: string;
  }): Promise<void> {
    this.memory.deleteCredentials(input);
    if (this.secrets && looksLikeSecretId(input.credentialReference)) {
      await this.secrets.deleteCredentials(input);
    }
  }
}

export function createCredentialStore(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): CompositeCredentialStore {
  const memory = new MemoryCredentialStore();
  const envStore = new EnvCredentialStore(env);
  const mode = config.credentialStore;
  if (mode === "secrets-manager") {
    if (!config.awsRegion) {
      throw new Error("AWS_REGION is required when PACKPROOF_CREDENTIAL_STORE=secrets-manager");
    }
    return new CompositeCredentialStore(
      memory,
      envStore,
      new SecretsManagerCredentialStore(createSecretsManagerClient(config.awsRegion)),
    );
  }
  return new CompositeCredentialStore(memory, envStore);
}
