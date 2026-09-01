import type {
  IntegrationCredentials,
  MutableCredentialStore,
} from "./credentials.js";

export class MemoryCredentialStore implements MutableCredentialStore {
  private readonly records = new Map<string, IntegrationCredentials>();

  put(credentials: IntegrationCredentials): void {
    this.records.set(credentials.credentialReference, {
      adapterKey: credentials.adapterKey,
      credentialReference: credentials.credentialReference,
      material: { ...credentials.material },
    });
  }

  async getCredentials(input: {
    adapterKey: string;
    credentialReference: string;
  }): Promise<IntegrationCredentials | null> {
    const found = this.records.get(input.credentialReference);
    if (!found || found.adapterKey !== input.adapterKey) {
      return null;
    }
    return {
      adapterKey: found.adapterKey,
      credentialReference: found.credentialReference,
      material: { ...found.material },
    };
  }

  deleteCredentials(input: { adapterKey: string; credentialReference: string }): void {
    const found = this.records.get(input.credentialReference);
    if (!found || found.adapterKey !== input.adapterKey) {
      return;
    }
    this.records.delete(input.credentialReference);
  }
}
