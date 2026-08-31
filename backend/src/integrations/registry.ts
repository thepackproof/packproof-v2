import type { Clock } from "../clock.js";
import { DomainError } from "../domain/errors.js";
import type { IntegrationAdapter } from "./adapter.js";
import { createDemoMarketplaceAdapter } from "./demo-marketplace.js";

export class IntegrationAdapterRegistry {
  constructor(private readonly adapters: Map<string, IntegrationAdapter>) {}

  get(adapterKey: string): IntegrationAdapter {
    const adapter = this.adapters.get(adapterKey);
    if (!adapter) {
      throw new DomainError(
        "INTEGRATION_ADAPTER_UNAVAILABLE",
        "No integration adapter is registered for this key",
        404,
      );
    }
    return adapter;
  }
}

export function createDefaultIntegrationRegistry(clock: Clock): IntegrationAdapterRegistry {
  const demo = createDemoMarketplaceAdapter(clock);
  return new IntegrationAdapterRegistry(new Map([[demo.adapterKey, demo]]));
}
