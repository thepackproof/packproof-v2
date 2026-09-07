import { DomainError } from "../../domain/errors.js";
import type { NormalizedFulfillmentOrder } from "../../domain/normalized-fulfillment-order.js";
import { etsyId } from "./client.js";
import type { EtsyMoney, EtsyReceipt } from "./types.js";

/** Etsy's amount is already an integer; price is per unit, never a line total. */
export function etsyMoneyValue(money: EtsyMoney | null): number | null {
  if (!money) return null;
  if (!Number.isSafeInteger(money.amount) || money.amount < 0 || ![1,10,100,1000,10000,100000,1000000].includes(money.divisor) || !/^[A-Z]{3}$/.test(money.currency_code)) {
    throw new DomainError("PROVIDER_RESPONSE_INVALID", "Etsy returned an invalid monetary amount.", 502);
  }
  return money.amount / money.divisor;
}

export function normalizeEtsyReceipt(receipt: EtsyReceipt, identity: { shopId: string; shopUserId: string }): NormalizedFulfillmentOrder {
  const shopId = etsyId(identity.shopId);
  const shopUserId = etsyId(identity.shopUserId);
  if (receipt.seller_user_id !== shopUserId || receipt.transactions.some(item => item.seller_user_id !== shopUserId || item.receipt_id !== receipt.receipt_id)) {
    throw new DomainError("INTEGRATION_TRUST_BOUNDARY", "The Etsy receipt does not belong to the connected seller shop.", 403);
  }
  const cancelled = receipt.status === "canceled" || receipt.status === "cancelled";
  const refunded = receipt.refundCount > 0 || /refunded/.test(receipt.status);
  const allPhysical = receipt.transactions.length > 0 && receipt.transactions.every(item => item.is_digital === false);
  const anyPhysical = receipt.transactions.some(item => item.is_digital === false);
  const anyShippedLine = receipt.transactions.some(item => item.shipped_timestamp != null);
  const allShippedLines = receipt.transactions.length > 0 && receipt.transactions.every(item => item.shipped_timestamp != null);
  const shipped = receipt.is_shipped === true || allShippedLines || receipt.status === "completed";
  const partialShipment = !shipped && (anyShippedLine || receipt.shipments.length > 0);
  const quantityValid = receipt.transactions.every(item => Number.isSafeInteger(item.quantity) && item.quantity > 0);
  const currencies = new Set([receipt.grandtotal?.currency_code, ...receipt.transactions.map(item => item.price?.currency_code)].filter(Boolean));
  const completeness = receipt.is_paid !== null && receipt.is_shipped !== null && receipt.transactions.length > 0 && quantityValid;
  let exclusion: string | null = null;
  if (!completeness) exclusion = "etsy_incomplete_fulfillment_details";
  else if (cancelled) exclusion = "etsy_cancelled_order";
  else if (refunded) exclusion = "etsy_refunded_order";
  else if (receipt.shipments.length > 1) exclusion = "etsy_multiple_shipments";
  else if (partialShipment) exclusion = "etsy_partial_shipment";
  else if (receipt.transactions.some(item => item.is_digital === null)) exclusion = "etsy_unknown_fulfillment";
  else if (!allPhysical) exclusion = anyPhysical ? "etsy_mixed_physical_and_digital_order" : "etsy_digital_order";
  else if (currencies.size > 1) exclusion = "etsy_inconsistent_currency";
  else if (receipt.is_paid && receipt.status !== "paid" && receipt.status !== "completed") exclusion = "etsy_unconfirmed_order_status";
  // Preserve all lines, including excluded receipts. Never silently convert an order into a different physical subset.
  const shipment = receipt.shipments.length === 1 ? receipt.shipments[0] : null;
  return {
    provider: "etsy", providerEnvironment: "production", identityAccountReference: shopId,
    externalAccountReference: shopId, externalOrderId: receipt.receipt_id, externalReference: receipt.receipt_id,
    orderedAt: new Date(receipt.create_timestamp * 1000).toISOString(),
    providerUpdatedAt: new Date(receipt.update_timestamp * 1000).toISOString(),
    paymentState: refunded ? "REFUNDED" : receipt.is_paid === true ? "CONFIRMED" : "PENDING",
    fulfillmentState: cancelled ? "CANCELLED" : shipped ? "FULFILLED" : partialShipment ? "IN_PROGRESS" : receipt.is_shipped === false ? "AWAITING_FULFILLMENT" : "UNKNOWN",
    requiresPhysicalFulfillment: allPhysical, cancelled, pilotCaptureExclusion: exclusion,
    items: receipt.transactions.map((item, index) => ({
      externalItemId: item.transaction_id, position: index + 1, title: item.title, description: null,
      sku: item.sku, quantity: item.quantity > 0 ? item.quantity : null,
      remainingQuantity: item.shipped_timestamp != null || shipped ? 0 : item.quantity > 0 ? item.quantity : null,
      unitValue: etsyMoneyValue(item.price), currency: item.price?.currency_code ?? receipt.grandtotal?.currency_code ?? null,
      variant: item.variations.length ? item.variations.map(option => `${option.formatted_name}: ${option.formatted_value}`).join("; ").slice(0, 400) : null,
    })),
    transactionValue: etsyMoneyValue(receipt.grandtotal), currency: receipt.grandtotal?.currency_code ?? null,
    buyer: receipt.buyer_user_id ? { externalId: receipt.buyer_user_id, displayName: null } : null,
    shipping: shipment ? { carrier: shipment.carrier_name, service: null, trackingNumber: shipment.tracking_code,
      shipmentDate: shipment.shipment_notification_timestamp ? new Date(shipment.shipment_notification_timestamp * 1000).toISOString().slice(0, 10) : null } : null,
    provenance: { source: "MARKETPLACE_API", sourceRecordId: receipt.receipt_id },
  };
}
