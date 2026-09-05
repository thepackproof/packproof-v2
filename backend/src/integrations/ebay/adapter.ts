import { ebayIdentityAccount } from "./normalize.js";
import type { Clock } from "../../clock.js";
import type { Database } from "../../db/database.js";
import { withEbayUserToken, type EbayRuntime } from "../../domain/ebay-marketplace.js";
import type { CommerceFulfillmentAdapter } from "../commerce-fulfillment-adapter.js";
import type { IntegrationCredentialStore, MutableCredentialStore } from "../credentials.js";
import { DomainError } from "../../domain/errors.js";
import type { NormalizedFulfillmentOrder } from "../../domain/normalized-fulfillment-order.js";
import type { EbayOrder } from "./types.js";
export function createEbayCommerceAdapter(db: Database, clock: Clock, runtime: EbayRuntime, credentials: IntegrationCredentialStore & Partial<Pick<MutableCredentialStore, "put">>): CommerceFulfillmentAdapter {
    return { adapterKey: "ebay", provider: "ebay", kind: "trusted", displayName: "eBay",
        async listFulfillmentOrders(input) {
            if (!runtime.enabled || !runtime.client)
                throw new DomainError("EBAY_INTEGRATION_DISABLED", "eBay is not enabled", 403);
            const offset = input.cursor ? Number(input.cursor) : 0;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
                throw new DomainError("PROVIDER_CURSOR_INVALID", "Invalid eBay page cursor", 400);
            const userId=input.credentials?.material.ebayUserId;
            if(!userId) throw new DomainError("INTEGRATION_NEEDS_REAUTH","Reconnect eBay to verify the merchant identity",409);
            const page = await withEbayUserToken(db, clock, runtime, credentials, input.connection, accessToken => runtime.client!.listOrders({
                environment: runtime.environment, marketplaceId: runtime.marketplaceId, accessToken, offset, limit: 50,
                updatedSince: input.updatedSince, updatedUntil: input.updatedUntil,
            }));
            return { orders: page.orders.map(order => ({...normalizeEbayFulfillmentOrder(order, input.connection.external_account_reference!, runtime.environment),identityAccountReference:ebayIdentityAccount(runtime.environment,userId)})),
                cursor: page.total !== null ? offset + page.orders.length < page.total && page.orders.length > 0 ? String(offset + page.limit) : null : page.orders.length === page.limit ? String(offset + page.limit) : null };
        },
    };
}
export function normalizeEbayFulfillmentOrder(order: EbayOrder, account: string, environment = "production"): NormalizedFulfillmentOrder {
    const cancelled = /^(CANCELED|CANCELLED)$/.test(order.cancelState ?? "");
    const amount = (value: string | null | undefined) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
    return { provider: "ebay", providerEnvironment: environment, externalAccountReference: account, externalOrderId: order.orderId, externalReference: order.orderId,
        orderedAt: order.creationDate ?? "", providerUpdatedAt: order.lastModifiedDate,
        paymentState: order.orderPaymentStatus === "PAID" ? "CONFIRMED" : order.orderPaymentStatus === "FULLY_REFUNDED" ? "REFUNDED" : order.orderPaymentStatus === "FAILED" ? "FAILED" : "PENDING",
        fulfillmentState: cancelled ? "CANCELLED" : order.orderFulfillmentStatus === "FULFILLED" ? "FULFILLED" : order.orderFulfillmentStatus === "IN_PROGRESS" ? "IN_PROGRESS" : order.orderFulfillmentStatus === "NOT_STARTED" ? "AWAITING_FULFILLMENT" : "UNKNOWN",
        requiresPhysicalFulfillment: order.requiresPhysicalFulfillment === true, cancelled,
        items: order.lineItems.map((item, index) => ({ externalItemId: item.lineItemId ?? item.legacyItemId, position: index + 1, title: item.title, description: null, sku: item.sku, quantity: item.quantity,
            remainingQuantity: item.fulfillmentStatus === "FULFILLED" ? 0 : item.fulfillmentStatus === "NOT_STARTED" ? item.quantity : null,
            unitValue: item.quantity && amount(item.lineItemCost?.value) !== null ? amount(item.lineItemCost?.value)! / item.quantity : amount(item.lineItemCost?.value), currency: item.lineItemCost?.currency ?? order.total?.currency ?? null })),
        transactionValue: amount(order.total?.value), currency: order.total?.currency ?? null,
        buyer: order.buyerUsername ? { externalId: order.buyerUsername, displayName: order.buyerUsername } : null,
        shipping: order.trackingNumber || order.shippingCarrier || order.shippingService ? { carrier: order.shippingCarrier, service: order.shippingService, trackingNumber: order.trackingNumber, shipmentDate: null } : null,
        provenance: { source: "MARKETPLACE_API", sourceRecordId: order.orderId } };
}
