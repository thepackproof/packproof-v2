import { describe, expect, it, vi } from "vitest";
import { createShopifyCommerceAdapter } from "../src/integrations/shopify/adapter.js";
import { eligibilityOf, fulfillmentOrderFingerprint, fulfillmentOrderToImportedTransaction, parseNormalizedFulfillmentOrder } from "../src/domain/normalized-fulfillment-order.js";
import type { ShopifyClient, ShopifyOrder } from "../src/integrations/shopify/types.js";
import type { IntegrationConnectionRow } from "../src/domain/integration-connections.js";

const order = (): ShopifyOrder => ({
  id: "1234", test: false, name: "#1001", createdAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:00:00Z",
  cancelledAt: null, financialStatus: "PAID", fulfillmentStatus: "UNFULFILLED", totalPrice: "60.00", currency: "USD",
  customer: null, trackingCompany: null, trackingNumber: null, fulfillments: [],
  lineItems: [{ id: "15", title: "Card", sku: "CARD", quantity: 3, currentQuantity: 3, remainingQuantity: 3, price: "20.00", requiresShipping: true }],
  fulfillmentOrders: [{ id: "92", status: "OPEN", requestStatus: "UNSUBMITTED", deliveryMethodType: "SHIPPING", merchantManaged: true, lineItems: [{ id: "43", orderLineItemId: "15", remainingQuantity: 3, requiresShipping: true }] }],
});
const input = { connection: { id: "conn-1", external_account_reference: "store" } as IntegrationConnectionRow, credentials: { material: { shop: "store.myshopify.com", accessToken: "old-token" } } as any };
async function normalize(source: ShopifyOrder) {
  const client = { listOrdersPage: async () => ({ orders: [source], cursor: null }) } as unknown as ShopifyClient;
  return parseNormalizedFulfillmentOrder((await createShopifyCommerceAdapter(client).listFulfillmentOrders(input)).orders[0]);
}

describe("Shopify merchant fulfillment intake", () => {
  it("starts one canonical order scope with only remaining physical items and explicit shipment provenance", async () => {
    const source = order();
    source.fulfillmentStatus = "PARTIALLY_FULFILLED";
    source.lineItems[0].remainingQuantity = 1;
    source.fulfillmentOrders[0].lineItems[0].remainingQuantity = 1;
    source.lineItems.push({ id: "16", title: "Digital certificate", sku: null, quantity: 1, currentQuantity: 1, remainingQuantity: 1, price: "0", requiresShipping: false });
    source.trackingCompany = "USPS"; source.trackingNumber = "HISTORICAL-TRACKING";
    source.fulfillments = [{ id: "77", trackingNumber: "HISTORICAL-TRACKING", lineItems: [{ id: "15", quantity: 2 }] }];
    const result = await normalize(source);
    expect(eligibilityOf(result)).toBe("FULFILLMENT_ELIGIBLE");
    expect(result).toMatchObject({ externalOrderId: "1234", merchantFulfillmentReady: true, shopifyRemainingFulfillmentOrderId: "92", shipping: null });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ quantity: 1, remainingQuantity: 1 });
    expect(result.packages?.[0].trackingNumber).toBe("HISTORICAL-TRACKING");
    expect(fulfillmentOrderToImportedTransaction(result, "2026-09-24T11:00:00Z")).toMatchObject({
      externalTransactionId: "1234", itemDescription: expect.stringContaining("Remaining shipment"),
      providerIdentifiers: { orderId: "1234", fulfillmentScope: "REMAINING_SHIPMENT", fulfillmentOrderId: "92" },
    });
  });

  it.each(["PENDING", "AUTHORIZED", "PARTIALLY_PAID"])("allows ready %s merchant work without claiming payment was confirmed", async status => {
    const source = order(); source.financialStatus = status;
    const result = await normalize(source);
    expect(result.paymentState).toBe("PENDING");
    expect(eligibilityOf(result)).toBe("FULFILLMENT_ELIGIBLE");
    expect(eligibilityOf({ ...result, merchantFulfillmentReady: false })).toBe("INELIGIBLE");
    expect(eligibilityOf({ ...result, provider: "etsy" })).toBe("INELIGIBLE");
  });

  it.each(["REFUNDED", "VOIDED", "EXPIRED", "unknown"])("excludes %s even when fulfillment assignment remains ready", async status => {
    const source = order(); source.financialStatus = status;
    expect(eligibilityOf(await normalize(source))).toBe("INELIGIBLE");
  });

  it("allows retained physical work after a partial refund", async () => {
    const source = order(); source.financialStatus = "PARTIALLY_REFUNDED";
    source.lineItems[0].currentQuantity = 2; source.lineItems[0].remainingQuantity = 2;
    source.fulfillmentOrders[0].lineItems[0].remainingQuantity = 2;
    expect(eligibilityOf(await normalize(source))).toBe("FULFILLMENT_ELIGIBLE");
  });

  it.each([["ON_HOLD", "SHOPIFY_FULFILLMENT_ON_HOLD"], ["SCHEDULED", "SHOPIFY_FULFILLMENT_SCHEDULED"], ["INCOMPLETE", "SHOPIFY_FULFILLMENT_UNAVAILABLE"]])("excludes %s based on the actual fulfillment order", async (status, code) => {
    const source = order(); source.fulfillmentOrders[0].status = status;
    const result = await normalize(source);
    expect(eligibilityOf(result)).toBe("INELIGIBLE");
    expect(result.pilotCaptureExclusion).toBe(code);
    expect(result.shopifyRemainingFulfillmentOrderId).toBeUndefined();
  });

  it("holds mixed ready and scheduled quantities for review under the one-Proof-per-order contract", async () => {
    const source = order(); source.fulfillmentOrders[0].lineItems[0].remainingQuantity = 2;
    source.fulfillmentOrders.push({ id: "93", status: "SCHEDULED", requestStatus: "UNSUBMITTED", deliveryMethodType: "SHIPPING", merchantManaged: true, lineItems: [{ id: "44", orderLineItemId: "15", remainingQuantity: 1, requiresShipping: true }] });
    const result = await normalize(source);
    expect(eligibilityOf(result)).toBe("INELIGIBLE");
    expect(result.pilotCaptureExclusion).toBe("SHOPIFY_FULFILLMENT_REVIEW_REQUIRED");
  });

  it("holds separate ready fulfillment assignments and unassigned remaining quantities for review", async () => {
    const source = order(); source.fulfillmentOrders[0].lineItems[0].remainingQuantity = 2;
    expect((await normalize(source)).pilotCaptureExclusion).toBe("SHOPIFY_FULFILLMENT_REVIEW_REQUIRED");
    source.fulfillmentOrders.push({ id: "93", status: "OPEN", requestStatus: "UNSUBMITTED", deliveryMethodType: "SHIPPING", merchantManaged: true, lineItems: [{ id: "44", orderLineItemId: "15", remainingQuantity: 1, requiresShipping: true }] });
    expect((await normalize(source)).pilotCaptureExclusion).toBe("SHOPIFY_FULFILLMENT_REVIEW_REQUIRED");
  });

  it("does not infer seller work from an unfulfilled order whose fulfillment assignment is inaccessible", async () => {
    const source = order(); source.fulfillmentOrders = [];
    const result = await normalize(source);
    expect(eligibilityOf(result)).toBe("INELIGIBLE");
    expect(result.pilotCaptureExclusion).toBe("SHOPIFY_FULFILLMENT_UNAVAILABLE");
  });

  it("requires assignment quantities to agree with the current order after an edit or refund", async () => {
    const source = order(); source.lineItems[0].currentQuantity = 2;
    expect((await normalize(source)).pilotCaptureExclusion).toBe("SHOPIFY_FULFILLMENT_REVIEW_REQUIRED");
    const extra = order();
    extra.lineItems.push({ id: "16", title: "Removed item", sku: null, quantity: 1, currentQuantity: 0, remainingQuantity: 1, price: "1", requiresShipping: true });
    extra.fulfillmentOrders[0].lineItems.push({ id: "44", orderLineItemId: "16", remainingQuantity: 1, requiresShipping: true });
    expect((await normalize(extra)).pilotCaptureExclusion).toBe("SHOPIFY_FULFILLMENT_REVIEW_REQUIRED");
  });

  it.each(["SHIPPING", "PICKUP_POINT"])("supports merchant shipment delivery method %s", async method => {
    const source = order(); source.fulfillmentOrders[0].deliveryMethodType = method;
    expect(eligibilityOf(await normalize(source))).toBe("FULFILLMENT_ELIGIBLE");
  });

  it.each(["PICK_UP", "RETAIL", "NONE", "LOCAL", "UNKNOWN", null])("does not start shipping capture for delivery method %s", async method => {
    const source = order(); source.fulfillmentOrders[0].deliveryMethodType = method;
    const result = await normalize(source);
    expect(eligibilityOf(result)).toBe("INELIGIBLE");
    expect(result.pilotCaptureExclusion).toBe("SHOPIFY_FULFILLMENT_UNAVAILABLE");
    expect(result.shopifyRemainingFulfillmentOrderId).toBeUndefined();
  });

  it("rejects unsubmitted fulfillment-service work even when granted scopes made the assignment readable", async () => {
    const source = order(); source.fulfillmentOrders[0].merchantManaged = false;
    const result = await normalize(source);
    expect(eligibilityOf(result)).toBe("INELIGIBLE");
    expect(result.pilotCaptureExclusion).toBe("SHOPIFY_FULFILLMENT_UNAVAILABLE");
    expect(result.merchantFulfillmentReady).toBeUndefined();
  });

  it.each(["test", "cancelled", "digital", "fulfilled", "service-assigned"])("excludes %s orders", async scenario => {
    const source = order();
    if (scenario === "test") source.test = true;
    if (scenario === "cancelled") source.cancelledAt = "2026-09-24T10:01:00Z";
    if (scenario === "digital") { source.lineItems[0].requiresShipping = false; source.fulfillmentOrders[0].lineItems[0].requiresShipping = false; }
    if (scenario === "fulfilled") { source.fulfillmentStatus = "FULFILLED"; source.lineItems[0].remainingQuantity = 0; source.fulfillmentOrders = []; }
    if (scenario === "service-assigned") source.fulfillmentOrders[0].requestStatus = "ACCEPTED";
    expect(eligibilityOf(await normalize(source))).toBe("INELIGIBLE");
  });

  it("fingerprints fulfillment assignment changes without changing canonical external order identity", async () => {
    const source = order(), first = await normalize(source); source.fulfillmentOrders[0].id = "93";
    const second = await normalize(source);
    expect(first.externalOrderId).toBe(second.externalOrderId);
    expect(fulfillmentOrderFingerprint(first)).not.toBe(fulfillmentOrderFingerprint(second));
  });

  it("uses refreshed credentials for both polling and exact order reads", async () => {
    const listOrdersPage = vi.fn(async (_input: unknown) => ({ orders: [order()], cursor: null }));
    const getOrder = vi.fn(async (_input: unknown) => order());
    const runner = vi.fn(async (_connection, operation) => operation("refreshed-token"));
    const adapter = createShopifyCommerceAdapter({ listOrdersPage, getOrder } as unknown as ShopifyClient, runner);
    await adapter.listFulfillmentOrders(input);
    await adapter.fetchFulfillmentOrder!({ ...input, externalOrderId: "1234" });
    expect(listOrdersPage).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "refreshed-token" }));
    expect(getOrder).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "refreshed-token" }));
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
