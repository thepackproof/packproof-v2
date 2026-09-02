import { DomainError } from "../../domain/errors.js";
import type { ConnectedAccountProviderId } from "../../domain/identity-providers.js";
import { requireConnectedAccountProvider } from "../../domain/identity-providers.js";
import type { ConnectedAccountProvider } from "./types.js";

export class ConnectedAccountProviderRegistry {
  constructor(private readonly providers: Map<string, ConnectedAccountProvider>) {}

  get(providerRaw: string): ConnectedAccountProvider {
    const provider = requireConnectedAccountProvider(providerRaw);
    const found = this.providers.get(provider);
    if (!found) {
      throw new DomainError(
        "INVALID_IDENTITY_PROVIDER",
        "Unsupported connected-account provider",
        400,
      );
    }
    return found;
  }

  list(): ConnectedAccountProvider[] {
    return [...this.providers.values()];
  }

  ids(): ConnectedAccountProviderId[] {
    return this.list().map((provider) => provider.provider);
  }
}
