import { DomainError } from "../../domain/errors.js";
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
import type { ShopifyAccessTokenRunner } from "./access.js";

export function createShopifyCommerceAdapter(client: ShopifyClient, withAccessToken?: ShopifyAccessTokenRunner): CommerceFulfillmentAdapter {
  const run = <T>(connection: IntegrationConnectionRow, credentials: IntegrationCredentials | null | undefined, operation: (token: string) => Promise<T>) =>
    withAccessToken ? withAccessToken(connection, operation) : operation(credentials?.material.accessToken?.trim() ?? "");
  return {
    adapterKey: SHOPIFY_ADAPTER_KEY,
    kind: "trusted",
    provider: SHOPIFY_PROVIDER,
    displayName: "Shopify",
    preferredPollIntervalMs: 300000,
    reconciliationIntervalMs: 86400000,
    async fetchFulfillmentOrder(input) {
      if (!client.getOrder) throw new DomainError("COMMERCE_EXACT_READ_UNAVAILABLE", "Choose this order from your connected packing queue", 409);
      const shop = shopFromConnection(input.connection, input.credentials);
      const includeProductIdentifiers = (input.credentials?.material.scope ?? "").split(/[ ,]+/).some(scope => scope === "read_products" || scope === "write_products");
      return toNormalized(await run(input.connection, input.credentials, accessToken => client.getOrder!({shop, accessToken, orderId: input.externalOrderId, includeProductIdentifiers})), shop);
    },
    async listFulfillmentOrders(input: {
      connection: IntegrationConnectionRow;
      credentials?: IntegrationCredentials | null;
      cursor?: string | null;
      updatedSince?: string;
      updatedUntil?: string;
      onProgress?: () => Promise<void>;
    }): Promise<CommerceOrderPage> {
      const shop = shopFromConnection(input.connection, input.credentials);
      const includeProductIdentifiers=(input.credentials?.material.scope??'').split(/[ ,]+/).some(scope=>scope==='read_products'||scope==='write_products');
      const page = await run(input.connection, input.credentials, async accessToken => client.listOrdersPage
        ? client.listOrdersPage({shop,accessToken,includeProductIdentifiers,limit:10,cursor:input.cursor,updatedSince:input.updatedSince,updatedUntil:input.updatedUntil,onProgress:input.onProgress})
        : {orders:await client.listOrders({shop,accessToken,includeProductIdentifiers,limit:50}),cursor:null});
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
  // The order's display status is only a summary. Actual seller work is the
  // remaining physical quantity assigned to ready merchant fulfillment orders.
  const physicalLines = order.lineItems.filter(item => item.requiresShipping === true &&
    (item.currentQuantity ?? item.quantity ?? 0) > 0 && (item.remainingQuantity ?? 0) > 0);
  const remaining = new Map<string, number>();
  let held = false, scheduled = false, unavailable = false;
  const readyOrders: ShopifyOrder["fulfillmentOrders"] = [];
  for (const fulfillment of order.fulfillmentOrders) {
    const physical = fulfillment.lineItems.filter(line => line.requiresShipping && line.remainingQuantity > 0);
    if (!physical.length) continue;
    if (["CLOSED", "CANCELLED"].includes(fulfillment.status)) continue;
    // Pickup, retail and local delivery have no supported outbound shipping
    // capture contract. A legacy token's extra scopes cannot make third-party
    // fulfillment-service work appear as work the merchant will pack.
    if (!fulfillment.merchantManaged || !["SHIPPING", "PICKUP_POINT"].includes(fulfillment.deliveryMethodType ?? "")) {
      unavailable = true;
      continue;
    }
    if (fulfillment.status === "ON_HOLD") held = true;
    else if (fulfillment.status === "SCHEDULED") scheduled = true;
    else if (["OPEN", "IN_PROGRESS"].includes(fulfillment.status) && fulfillment.requestStatus === "UNSUBMITTED") {
      readyOrders.push(fulfillment);
      for (const line of physical) remaining.set(line.orderLineItemId, (remaining.get(line.orderLineItemId) ?? 0) + line.remainingQuantity);
    } else if (!["CLOSED", "CANCELLED"].includes(fulfillment.status)) unavailable = true;
  }
  const hasReady = readyOrders.length > 0;
  const allRemainingReady = physicalLines.length > 0 && remaining.size === physicalLines.length && physicalLines.every(line =>
    line.id && remaining.get(line.id) === line.remainingQuantity && (line.remainingQuantity ?? 0) <= (line.currentQuantity ?? line.quantity ?? 0));
  let exclusion: string | null = null;
  if (order.test) exclusion = "SHOPIFY_TEST_ORDER";
  else if (!order.cancelledAt && physicalLines.length) {
    if ((hasReady && (held || scheduled || unavailable || !allRemainingReady)) || readyOrders.length > 1) exclusion = "SHOPIFY_FULFILLMENT_REVIEW_REQUIRED";
    else if (held) exclusion = "SHOPIFY_FULFILLMENT_ON_HOLD";
    else if (scheduled) exclusion = "SHOPIFY_FULFILLMENT_SCHEDULED";
    else if (!hasReady || !allRemainingReady) exclusion = "SHOPIFY_FULFILLMENT_UNAVAILABLE";
  }
  const merchantFulfillmentReady = hasReady && allRemainingReady && !exclusion && !order.cancelledAt;
  const items: NormalizedOrderItem[] = physicalLines.map((item, index) => ({
    externalItemId: item.id,
    position: index + 1,
    title: item.title,
    description: item.variantTitle ?? null,
    remainingQuantity: item.remainingQuantity ?? null,
    variant: item.variantTitle ?? null,
    sku: item.sku,
    ...(item.barcode !== undefined ? {barcode:item.barcode,variantId:item.variantId,productId:item.productId} : {}),
    quantity: item.remainingQuantity ?? null,
    unitValue: parseMoney(item.price),
    currency: order.currency,
  }));
  const requiresShipping = physicalLines.length > 0;
  return {
    provider: SHOPIFY_PROVIDER,
    externalAccountReference: account,
    externalOrderId: order.id,
    externalReference: order.name,
    orderedAt: order.createdAt ?? "1970-01-01T00:00:00.000Z",
    paymentState: paymentState(order.financialStatus),
    merchantFulfillmentReady,
    ...(merchantFulfillmentReady ? { shopifyRemainingFulfillmentOrderId: readyOrders[0].id } : {}),
    ...(exclusion ? { pilotCaptureExclusion: exclusion } : {}),
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
      !requiresShipping && (order.trackingCompany || order.trackingNumber)
        ? {
            carrier: order.trackingCompany,
            service: null,
            trackingNumber: order.trackingNumber,
            shipmentDate: null,
          }
        : null,
    providerUpdatedAt: order.updatedAt ?? null,
    onHold: held || scheduled || (order.fulfillmentHolds ?? false),
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
    case "partially_refunded":
      return "CONFIRMED";
    case "pending":
    case "authorized":
    case "partially_paid":
      return "PENDING";
    case "refunded":
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
