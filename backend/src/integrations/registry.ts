import type { Clock } from "../clock.js";
import { DomainError } from "../domain/errors.js";
import type { IntegrationAdapter } from "./adapter.js";
import { createDemoMarketplaceAdapter } from "./demo-marketplace.js";
import { createDemoCarrierAdapter } from "./demo-carrier.js";
import type { ShipmentObservationAdapter } from "./shipment-adapter.js";

export class IntegrationAdapterRegistry {
  constructor(
    private readonly adapters: Map<string, IntegrationAdapter>,
    private readonly shipmentAdapters: Map<string, ShipmentObservationAdapter> = new Map(),
  ) {}

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

  getShipment(adapterKey: string): ShipmentObservationAdapter {
    const adapter = this.shipmentAdapters.get(adapterKey);
    if (!adapter) {
      throw new DomainError(
        "INTEGRATION_ADAPTER_UNAVAILABLE",
        "No shipment adapter is registered for this key",
        404,
      );
    }
    return adapter;
  }
}

export function createDefaultIntegrationRegistry(clock: Clock): IntegrationAdapterRegistry {
  const demo = createDemoMarketplaceAdapter(clock);
  const carrier = createDemoCarrierAdapter(clock);
  return new IntegrationAdapterRegistry(
    new Map([[demo.adapterKey, demo]]),
    new Map([[carrier.adapterKey, carrier]]),
  );
}
