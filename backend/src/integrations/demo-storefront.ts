import type { IntegrationConnectionRow } from "../domain/integration-connections.js";
import type {
  CommerceOrderPage,
  NormalizedFulfillmentOrder,
  NormalizedOrderItem,
} from "../domain/normalized-fulfillment-order.js";
import { parseNormalizedFulfillmentOrder } from "../domain/normalized-fulfillment-order.js";
import type { NormalizedFulfillmentState } from "../domain/fulfillment-eligibility.js";
import type { NormalizedPaymentState } from "../domain/fulfillment-eligibility.js";
import type { CommerceFulfillmentAdapter } from "./commerce-fulfillment-adapter.js";

export const DEMO_STOREFRONT_ADAPTER_KEY = "demo-storefront";
export const DEMO_STOREFRONT_PROVIDER = "demo-storefront";
export const DEMO_STOREFRONT_DISPLAY_NAME = "Demo Storefront";
export const DEMO_STORE_ACCOUNT_PRIMARY = "demo-store-001";
export const DEMO_STORE_ACCOUNT_SECONDARY = "demo-store-002";
export const DEMO_STOREFRONT_CREDENTIAL_REFERENCE = "reference:demo-storefront";

export type DemoOrderOverride = Partial<
  Pick<
    NormalizedFulfillmentOrder,
    "paymentState" | "fulfillmentState" | "cancelled" | "requiresPhysicalFulfillment"
  >
>;

export interface DemoStorefrontAdapter extends CommerceFulfillmentAdapter {
  applyOrderOverride(
    externalAccountReference: string,
    externalOrderId: string,
    override: DemoOrderOverride,
  ): void;
  resetOverrides(): void;
}

function item(
  id: string,
  position: number,
  title: string,
  quantity: number,
  unitValue: number,
  description?: string,
): NormalizedOrderItem {
  return {
    externalItemId: id,
    position,
    title,
    description: description ?? null,
    sku: id.replace("line-", "SKU-"),
    quantity,
    unitValue,
    currency: "USD",
  };
}

function catalogFor(account: string): NormalizedFulfillmentOrder[] {
  const buyer = { externalId: `buyer-${account}`, displayName: "Jordan Buyer" };
  const provenance = {
    source: "STOREFRONT_API" as const,
    sourceRecordId: null as string | null,
  };
  const base = {
    provider: DEMO_STOREFRONT_PROVIDER,
    externalAccountReference: account,
    buyer,
    shipping: null,
    currency: "USD",
    provenance,
  };

  return [
    {
      ...base,
      externalOrderId: "DS-1001",
      externalReference: "DS-1001",
      orderedAt: "2026-08-01T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "AWAITING_FULFILLMENT",
      requiresPhysicalFulfillment: true,
      cancelled: false,
      items: [
        item("line-1001-1", 1, "Pokémon Booster Box", 1, 229, "Sealed English booster box"),
      ],
      transactionValue: 229,
      providerUpdatedAt: "2026-08-01T15:05:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1001` },
    },
    {
      ...base,
      externalOrderId: "DS-1002",
      externalReference: "DS-1002",
      orderedAt: "2026-08-02T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "AWAITING_FULFILLMENT",
      requiresPhysicalFulfillment: true,
      cancelled: false,
      items: [item("line-1002-1", 1, "Vintage Watch", 1, 1500, "Mechanical dress watch")],
      transactionValue: 1500,
      providerUpdatedAt: "2026-08-02T15:05:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1002` },
    },
    {
      ...base,
      externalOrderId: "DS-1003",
      externalReference: "DS-1003",
      orderedAt: "2026-08-03T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "AWAITING_FULFILLMENT",
      requiresPhysicalFulfillment: true,
      cancelled: false,
      items: [
        item("line-1003-1", 1, "Vintage lens", 1, 180, "Prime 50mm"),
        item("line-1003-2", 2, "Camera strap", 1, 24, "Leather strap"),
        item("line-1003-3", 3, "Lens cap", 1, 6, "Front cap"),
      ],
      transactionValue: 210,
      providerUpdatedAt: "2026-08-03T15:05:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1003` },
    },
    {
      ...base,
      externalOrderId: "DS-1004",
      externalReference: "DS-1004",
      orderedAt: "2026-08-04T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "AWAITING_FULFILLMENT",
      requiresPhysicalFulfillment: true,
      cancelled: false,
      items: [item("line-1004-1", 1, "Sticker pack", 4, 4.5, "Holo sticker assortment")],
      transactionValue: 18,
      providerUpdatedAt: "2026-08-04T15:05:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1004` },
    },
    {
      ...base,
      externalOrderId: "DS-1005",
      externalReference: "DS-1005",
      orderedAt: "2026-08-05T15:00:00.000Z",
      paymentState: "PENDING",
      fulfillmentState: "AWAITING_FULFILLMENT",
      requiresPhysicalFulfillment: true,
      cancelled: false,
      items: [item("line-1005-1", 1, "Pending print", 1, 40, "Unpaid art print")],
      transactionValue: 40,
      providerUpdatedAt: "2026-08-05T15:05:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1005` },
    },
    {
      ...base,
      externalOrderId: "DS-1006",
      externalReference: "DS-1006",
      orderedAt: "2026-08-06T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "CANCELLED",
      requiresPhysicalFulfillment: true,
      cancelled: true,
      items: [item("line-1006-1", 1, "Cancelled figure", 1, 55)],
      transactionValue: 55,
      providerUpdatedAt: "2026-08-06T16:00:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1006` },
    },
    {
      ...base,
      externalOrderId: "DS-1007",
      externalReference: "DS-1007",
      orderedAt: "2026-08-07T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "FULFILLED",
      requiresPhysicalFulfillment: true,
      cancelled: false,
      items: [item("line-1007-1", 1, "Already shipped mug", 1, 22)],
      transactionValue: 22,
      providerUpdatedAt: "2026-08-07T18:00:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1007` },
    },
    {
      ...base,
      externalOrderId: "DS-1008",
      externalReference: "DS-1008",
      orderedAt: "2026-08-08T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "AWAITING_FULFILLMENT",
      requiresPhysicalFulfillment: false,
      cancelled: false,
      items: [item("line-1008-1", 1, "Digital guidebook", 1, 12, "PDF download")],
      transactionValue: 12,
      providerUpdatedAt: "2026-08-08T15:05:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1008` },
    },
    {
      ...base,
      externalOrderId: "DS-1009",
      externalReference: "DS-1009",
      orderedAt: "2026-08-09T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "IN_PROGRESS",
      requiresPhysicalFulfillment: true,
      cancelled: false,
      items: [
        item("line-1009-1", 1, "Partial kit box", 1, 80),
        item("line-1009-2", 2, "Partial kit insert", 1, 10),
      ],
      transactionValue: 90,
      providerUpdatedAt: "2026-08-09T16:00:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1009` },
    },
    {
      ...base,
      externalOrderId: "DS-1010",
      externalReference: "DS-1010",
      orderedAt: "2026-08-10T15:00:00.000Z",
      paymentState: "CONFIRMED",
      fulfillmentState: "AWAITING_FULFILLMENT",
      requiresPhysicalFulfillment: true,
      cancelled: false,
      items: [item("line-1010-1", 1, "Enamel pin", 1, 14)],
      transactionValue: 14,
      providerUpdatedAt: "2026-08-10T15:05:00.000Z",
      provenance: { ...provenance, sourceRecordId: `${account}:DS-1010` },
    },
  ].map((order) => parseNormalizedFulfillmentOrder(order));
}

export function createDemoStorefrontAdapter(): DemoStorefrontAdapter {
  const overrides = new Map<string, DemoOrderOverride>();

  function overrideKey(account: string, orderId: string): string {
    return `${account.trim().toLowerCase()}:${orderId.trim()}`;
  }

  function ordersFor(connection: IntegrationConnectionRow): NormalizedFulfillmentOrder[] {
    const account = (connection.external_account_reference ?? DEMO_STORE_ACCOUNT_PRIMARY)
      .trim()
      .toLowerCase();
    return catalogFor(account).map((order) => {
      const override = overrides.get(overrideKey(account, order.externalOrderId));
      if (!override) {
        return order;
      }
      return parseNormalizedFulfillmentOrder({
        ...order,
        ...override,
        providerUpdatedAt: "2026-08-31T18:00:00.000Z",
      });
    });
  }

  return {
    adapterKey: DEMO_STOREFRONT_ADAPTER_KEY,
    kind: "reference",
    provider: DEMO_STOREFRONT_PROVIDER,
    displayName: DEMO_STOREFRONT_DISPLAY_NAME,
    applyOrderOverride(externalAccountReference, externalOrderId, override) {
      overrides.set(overrideKey(externalAccountReference, externalOrderId), override);
    },
    resetOverrides() {
      overrides.clear();
    },
    async listFulfillmentOrders(input): Promise<CommerceOrderPage> {
      return { orders: ordersFor(input.connection), cursor: null };
    },
    async fetchFulfillmentOrder(input): Promise<NormalizedFulfillmentOrder> {
      const found = ordersFor(input.connection).find(
        (order) => order.externalOrderId === input.externalOrderId,
      );
      if (!found) {
        throw new Error(`Demo storefront order ${input.externalOrderId} was not found`);
      }
      return found;
    },
  };
}

export function applyDemoStorefrontScenario(
  adapter: DemoStorefrontAdapter,
  input: {
    scenario?: string;
    externalAccountReference?: string | null;
    externalOrderId?: string | null;
    paymentState?: NormalizedPaymentState;
    fulfillmentState?: NormalizedFulfillmentState;
    cancelled?: boolean;
  },
): { externalAccountReference: string; externalOrderId: string } {
  const account = (input.externalAccountReference ?? DEMO_STORE_ACCOUNT_PRIMARY).trim().toLowerCase();
  if (input.scenario === "pending-eligible") {
    const orderId = input.externalOrderId?.trim() || "DS-1005";
    adapter.applyOrderOverride(account, orderId, {
      paymentState: "CONFIRMED",
      fulfillmentState: "AWAITING_FULFILLMENT",
      cancelled: false,
      requiresPhysicalFulfillment: true,
    });
    return { externalAccountReference: account, externalOrderId: orderId };
  }
  if (input.scenario === "cancel-eligible") {
    const orderId = input.externalOrderId?.trim() || "DS-1001";
    adapter.applyOrderOverride(account, orderId, {
      cancelled: true,
      fulfillmentState: "CANCELLED",
    });
    return { externalAccountReference: account, externalOrderId: orderId };
  }
  const orderId = input.externalOrderId?.trim();
  if (!orderId) {
    throw new Error("externalOrderId is required unless a named scenario is used");
  }
  adapter.applyOrderOverride(account, orderId, {
    paymentState: input.paymentState,
    fulfillmentState: input.fulfillmentState,
    cancelled: input.cancelled,
  });
  return { externalAccountReference: account, externalOrderId: orderId };
}
