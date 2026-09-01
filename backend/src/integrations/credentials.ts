export interface IntegrationCredentials {
  readonly adapterKey: string;
  readonly credentialReference: string;
  readonly material: Readonly<Record<string, string>>;
}

export interface IntegrationCredentialStore {
  getCredentials(input: {
    adapterKey: string;
    credentialReference: string;
    connectionId?: string;
  }): Promise<IntegrationCredentials | null>;
}

export interface MutableCredentialStore extends IntegrationCredentialStore {
  put(credentials: IntegrationCredentials): void | Promise<void>;
  deleteCredentials(input: {
    adapterKey: string;
    credentialReference: string;
  }): void | Promise<void>;
}

export function materialWithoutSecrets(material: Record<string, string>): string[] {
  return Object.keys(material).sort();
}
