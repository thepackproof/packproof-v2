import type { ImportedTransaction } from "../../domain/imported-transaction.js";
import type { EbayEnvironment } from "./constants.js";
import type { EbayOrder } from "./types.js";

export interface EbayOrderSummary {
  externalOrderId: string;
  title: string;
  soldAt: string | null;
  total: number | null;
  currency: string | null;
  fulfillmentStatus: string;
  fulfillmentLabel: string;
  buyerUsername: string | null;
  quantity: number | null;
}

export function ebayAccountReference(userId: string, username: string | null): string {
  const candidate = (username || userId).trim().toLowerCase();
  const cleaned = candidate.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  if (cleaned && /^[a-z0-9][a-z0-9._-]*$/.test(cleaned)) {
    return cleaned;
  }
  const fromId = userId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 100);
  return `ebay-${fromId || "account"}`;
}

export function summarizeEbayOrder(order: EbayOrder): EbayOrderSummary {
  const title =
    order.lineItems.length > 1
      ? `${order.lineItems[0]?.title ?? "eBay order"} + ${order.lineItems.length - 1} more`
      : (order.lineItems[0]?.title ?? "eBay order");
  const quantity = order.lineItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0) || null;
  return {
    externalOrderId: order.orderId,
    title,
    soldAt: order.creationDate,
    total: parseAmount(order.total?.value),
    currency: order.total?.currency ?? "USD",
    fulfillmentStatus: order.orderFulfillmentStatus ?? "UNKNOWN",
    fulfillmentLabel: fulfillmentLabel(order.orderFulfillmentStatus, order.cancelState),
    buyerUsername: order.buyerUsername,
    quantity,
  };
}

export function ebayOrderToImportedTransaction(input: {
  order: EbayOrder;
  environment: EbayEnvironment;
  importedAt: string;
}): ImportedTransaction {
  const { order, environment, importedAt } = input;
  const summary = summarizeEbayOrder(order);
  return {
    provider: "ebay",
    externalTransactionId: order.orderId,
    externalAccountReference: environment,
    externalReference: order.orderId,
    transactionDate: order.creationDate ? order.creationDate.slice(0, 10) : null,
    itemTitle: summary.title,
    itemDescription: null,
    quantity: summary.quantity,
    transactionValue: summary.total,
    currency: summary.currency,
    items: order.lineItems.map((item, index) => ({
      externalItemId: item.lineItemId ?? item.legacyItemId,
      position: index + 1,
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
      unitValue: parseAmount(item.lineItemCost?.value),
      currency: item.lineItemCost?.currency ?? summary.currency,
    })),
    shipping:
      order.shippingCarrier || order.shippingService || order.trackingNumber
        ? {
            carrier: order.shippingCarrier,
            service: order.shippingService,
            trackingNumber: order.trackingNumber,
            shipmentDate: null,
          }
        : null,
    buyer: order.buyerUsername
      ? { externalId: order.buyerUsername, displayName: order.buyerUsername }
      : null,
    provenance: {
      source: "MARKETPLACE_API",
      sourceRecordId: order.orderId,
      importedAt,
    },
    providerIdentifiers: {
      orderId: order.orderId,
      legacyOrderId: order.legacyOrderId,
      lineItemIds: order.lineItems.map((item) => item.lineItemId).filter((id): id is string => Boolean(id)),
      itemIds: order.lineItems.map((item) => item.legacyItemId).filter((id): id is string => Boolean(id)),
      environment,
    },
  };
}

function fulfillmentLabel(status: string | null, cancelState: string | null): string {
  if ((cancelState ?? "").toUpperCase().includes("CANCELED") || (cancelState ?? "").toUpperCase().includes("CANCELLED")) {
    return "Cancelled";
  }
  switch ((status ?? "").toUpperCase()) {
    case "NOT_STARTED":
      return "Ready to ship";
    case "IN_PROGRESS":
      return "Shipping";
    case "FULFILLED":
      return "Shipped";
    default:
      return status ? status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown";
  }
}

function parseAmount(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
