import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export class InMemorySecretsManagerClient {
  readonly secrets = new Map<string, string>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetSecretValueCommand) {
      const secretId = command.input.SecretId;
      if (!secretId || !this.secrets.has(secretId)) {
        throw named("ResourceNotFoundException");
      }
      return { SecretString: this.secrets.get(secretId) };
    }
    if (command instanceof PutSecretValueCommand) {
      const secretId = command.input.SecretId;
      const secretString = command.input.SecretString;
      if (!secretId || secretString == null) {
        throw named("InvalidRequestException");
      }
      if (!this.secrets.has(secretId)) {
        throw named("ResourceNotFoundException");
      }
      this.secrets.set(secretId, secretString);
      return {};
    }
    if (command instanceof CreateSecretCommand) {
      const name = command.input.Name;
      const secretString = command.input.SecretString;
      if (!name || secretString == null) {
        throw named("InvalidRequestException");
      }
      if (this.secrets.has(name)) {
        throw named("ResourceExistsException");
      }
      this.secrets.set(name, secretString);
      return {};
    }
    if (command instanceof DeleteSecretCommand) {
      const secretId = command.input.SecretId;
      if (!secretId) {
        throw named("InvalidRequestException");
      }
      this.secrets.delete(secretId);
      return {};
    }
    throw new Error("Unsupported Secrets Manager command");
  }
}

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
