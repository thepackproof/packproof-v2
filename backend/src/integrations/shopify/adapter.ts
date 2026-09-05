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
      updatedSince?: string;
      updatedUntil?: string;
      onProgress?: () => Promise<void>;
    }): Promise<CommerceOrderPage> {
      const shop = shopFromConnection(input.connection, input.credentials);
      const accessToken = input.credentials?.material.accessToken?.trim() ?? "";
      const page = client.listOrdersPage
        ? await client.listOrdersPage({shop,accessToken,limit:10,cursor:input.cursor,updatedSince:input.updatedSince,updatedUntil:input.updatedUntil,onProgress:input.onProgress})
        : {orders:await client.listOrders({shop,accessToken,limit:50}),cursor:null};
      const orders=page.orders;
      return {
        orders: orders.filter((order) => Boolean(order.createdAt)).map((order) => toNormalized(order, shop)),
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
  const items: NormalizedOrderItem[] = order.lineItems.filter(item => item.currentQuantity !== 0).map((item, index) => ({
    externalItemId: item.id,
    position: index + 1,
    title: item.title,
    description: item.variantTitle ?? null,
    remainingQuantity: item.remainingQuantity ?? null,
    variant: item.variantTitle ?? null,
    sku: item.sku,
    quantity: item.currentQuantity ?? item.quantity,
    unitValue: parseMoney(item.price),
    currency: order.currency,
  }));
  const requiresShipping = order.lineItems.some((item) => item.requiresShipping === true && (item.currentQuantity ?? item.quantity ?? 0) > 0);
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
    providerUpdatedAt: order.updatedAt ?? null,
    onHold: order.fulfillmentHolds ?? false,
    packages: (order.fulfillments ?? []).map(f=>({externalFulfillmentId:f.id,trackingNumber:f.trackingNumber,lineItems:f.lineItems})),
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
    case "expired":
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
    case "partially_fulfilled":
    case "in_progress":
    case "pending_fulfillment":
      return "IN_PROGRESS";
    case "unfulfilled":
    case "open":
    case "on_hold":
    case "scheduled":
    case "request_declined":
    case "restocked":
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
