import type {
  CommerceOrderPage,
  NormalizedFulfillmentOrder,
  NormalizedOrderItem,
} from "../../domain/normalized-fulfillment-order.js";
import type { NormalizedFulfillmentState } from "../../domain/fulfillment-eligibility.js";
import type { NormalizedPaymentState } from "../../domain/fulfillment-eligibility.js";
import type { IntegrationConnectionRow } from "../../domain/integration-connections.js";
import type { CommerceFulfillmentAdapter } from "../commerce-fulfillment-adapter.js";
import type { IntegrationCredentials } from "../credentials.js";
import { SHOPIFY_ADAPTER_KEY, SHOPIFY_PROVIDER } from "./constants.js";
import { shopifyShopHandle } from "./shop.js";
import type { ShopifyClient, ShopifyOrder } from "./types.js";

export function createShopifyCommerceAdapter(client: ShopifyClient): CommerceFulfillmentAdapter {
  return {
    adapterKey: SHOPIFY_ADAPTER_KEY,
    kind: "trusted",
    provider: SHOPIFY_PROVIDER,
    displayName: "Shopify",
    async listFulfillmentOrders(input: {
      connection: IntegrationConnectionRow;
      credentials?: IntegrationCredentials | null;
      cursor?: string | null;
    }): Promise<CommerceOrderPage> {
      const shop = shopFromConnection(input.connection, input.credentials);
      const accessToken = input.credentials?.material.accessToken?.trim() ?? "";
      const page = await client.listOrders({ shop, accessToken, limit: 50, cursor: input.cursor });
      return {
        orders: page.orders.filter((order) => Boolean(order.createdAt)).map((order) => toNormalized(order, shop)),
        cursor: page.cursor,
      };
    },
  };
}

function shopFromConnection(
  connection: IntegrationConnectionRow,
  credentials?: IntegrationCredentials | null,
): string {
  const fromMaterial = credentials?.material.shop?.trim();
  const fromRef = connection.external_account_reference?.trim();
  const shop = fromMaterial || (fromRef?.includes(".") ? fromRef : `${fromRef}.myshopify.com`);
  return shop;
}

function toNormalized(order: ShopifyOrder, shop: string): NormalizedFulfillmentOrder {
  const account = shopifyShopHandle(shop);
  const items: NormalizedOrderItem[] = order.lineItems.map((item, index) => ({
    externalItemId: item.id,
    position: index + 1,
    title: item.title,
    description: null,
    sku: item.sku,
    quantity: item.quantity,
    unitValue: parseMoney(item.price),
    currency: order.currency,
  }));
  const requiresShipping = order.lineItems.some((item) => item.requiresShipping !== false);
  return {
    provider: SHOPIFY_PROVIDER,
    externalAccountReference: account,
    externalOrderId: order.id,
    externalReference: order.name,
    orderedAt: order.createdAt ?? "1970-01-01T00:00:00.000Z",
    paymentState: paymentState(order.financialStatus),
    fulfillmentState: fulfillmentState(order.fulfillmentStatus, order.cancelledAt),
    requiresPhysicalFulfillment: requiresShipping,
    cancelled: Boolean(order.cancelledAt),
    items,
    transactionValue: parseMoney(order.totalPrice),
    currency: order.currency,
    buyer: order.customer
      ? { externalId: order.customer.id, displayName: order.customer.displayName }
      : null,
    shipping:
      order.trackingCompany || order.trackingNumber
        ? {
            carrier: order.trackingCompany,
            service: null,
            trackingNumber: order.trackingNumber,
            shipmentDate: null,
          }
        : null,
    providerUpdatedAt: null,
    provenance: {
      source: "STOREFRONT_API",
      sourceRecordId: order.id,
    },
  };
}

function paymentState(value: string | null): NormalizedPaymentState {
  switch ((value ?? "").toLowerCase()) {
    case "paid":
      return "CONFIRMED";
    case "pending":
    case "authorized":
    case "partially_paid":
      return "PENDING";
    case "refunded":
    case "partially_refunded":
      return "REFUNDED";
    case "voided":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

function fulfillmentState(
  value: string | null,
  cancelledAt: string | null,
): NormalizedFulfillmentState {
  if (cancelledAt) {
    return "CANCELLED";
  }
  switch ((value ?? "").toLowerCase()) {
    case "fulfilled":
      return "FULFILLED";
    case "partial":
      return "IN_PROGRESS";
    case "unfulfilled":
    case "":
      return "AWAITING_FULFILLMENT";
    default:
      return value ? "UNKNOWN" : "AWAITING_FULFILLMENT";
  }
}

function parseMoney(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
