import type { Clock } from "../clock.js";
import { DomainError } from "../domain/errors.js";
import { integrationTrustBoundary } from "../domain/integration-errors.js";
import type { IntegrationAdapter } from "./adapter.js";
import type { CommerceFulfillmentAdapter } from "./commerce-fulfillment-adapter.js";
import { createDemoMarketplaceAdapter } from "./demo-marketplace.js";
import { createDemoCarrierAdapter } from "./demo-carrier.js";
import { createDemoStorefrontAdapter } from "./demo-storefront.js";
import type { ShipmentObservationAdapter } from "./shipment-adapter.js";
import { createTrustedDemoCarrierAdapter } from "./trusted-demo-carrier.js";
import type { TrustedShipmentAdapter } from "./trusted-shipment-adapter.js";
import { createEasyPostShipmentAdapter } from "./easypost/adapter.js";
import type { EasyPostTrackerClient } from "./easypost/client.js";
import { createShopifyCommerceAdapter } from "./shopify/adapter.js";
import { createHttpShopifyClient } from "./shopify/client.js";
import type { ShopifyClient } from "./shopify/types.js";

export class IntegrationAdapterRegistry {
  constructor(
    private readonly adapters: Map<string, IntegrationAdapter>,
    private readonly shipmentAdapters: Map<string, ShipmentObservationAdapter> = new Map(),
    private readonly trustedShipmentAdapters: Map<string, TrustedShipmentAdapter> = new Map(),
    private readonly commerceAdapters: Map<string, CommerceFulfillmentAdapter> = new Map(),
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
    if (this.trustedShipmentAdapters.has(adapterKey)) {
      throw integrationTrustBoundary("This route accepts reference adapters only");
    }
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

  getTrustedShipment(adapterKey: string): TrustedShipmentAdapter {
    if (this.shipmentAdapters.has(adapterKey) || this.adapters.has(adapterKey)) {
      throw integrationTrustBoundary(
        "Reference adapters cannot execute through the trusted runtime",
      );
    }
    const adapter = this.trustedShipmentAdapters.get(adapterKey);
    if (!adapter) {
      throw new DomainError(
        "INTEGRATION_ADAPTER_UNAVAILABLE",
        "No trusted shipment adapter is registered for this key",
        404,
      );
    }
    return adapter;
  }

  getCommerce(adapterKey: string): CommerceFulfillmentAdapter {
    const adapter = this.commerceAdapters.get(adapterKey);
    if (!adapter) {
      throw new DomainError(
        "INTEGRATION_ADAPTER_UNAVAILABLE",
        "No commerce fulfillment adapter is registered for this key",
        404,
      );
    }
    return adapter;
  }

  hasCommerce(adapterKey: string): boolean {
    return this.commerceAdapters.has(adapterKey);
  }

  listCommerceAdapterKeys(): string[] {
    return [...this.commerceAdapters.keys()];
  }
}

export function createDefaultIntegrationRegistry(
  clock: Clock,
  options: { easypostClient?: EasyPostTrackerClient; shopifyClient?: ShopifyClient } = {},
): IntegrationAdapterRegistry {
  const demo = createDemoMarketplaceAdapter(clock);
  const carrier = createDemoCarrierAdapter(clock);
  const trusted = createTrustedDemoCarrierAdapter();
  const easypost = createEasyPostShipmentAdapter(options.easypostClient);
  const storefront = createDemoStorefrontAdapter();
  const shopify = createShopifyCommerceAdapter(options.shopifyClient ?? createHttpShopifyClient());
  return new IntegrationAdapterRegistry(
    new Map([[demo.adapterKey, demo]]),
    new Map([[carrier.adapterKey, carrier]]),
    new Map([
      [trusted.adapterKey, trusted],
      [easypost.adapterKey, easypost],
    ]),
    new Map([
      [storefront.adapterKey, storefront],
      [shopify.adapterKey, shopify],
    ]),
  );
}
