import { describe, expect, it, vi } from "vitest";
import { createHttpShopifyClient } from "../src/integrations/shopify/client.js";
import { createShopifyCommerceAdapter } from "../src/integrations/shopify/adapter.js";
import { SHOPIFY_SCOPES } from "../src/integrations/shopify/constants.js";
import type { IntegrationConnectionRow } from "../src/domain/integration-connections.js";

const input = { shop: "store.myshopify.com", accessToken: "server-only-token", updatedSince: "2026-01-01T00:00:00Z", updatedUntil: "2026-09-05T12:00:00Z" };
const revision = "2026-09-05T11:00:00.000Z";
const id = "9007199254740993123", gid = `gid://shopify/Order/${id}`;
const conn = (nodes: unknown[], cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor } });
const line = (n: number) => ({ id: `gid://shopify/LineItem/${n}`, title: `Card ${n}`, sku: "CARD", quantity: 3, currentQuantity: 3, unfulfilledQuantity: 1, variantTitle: "Blue", requiresShipping: true, originalUnitPriceSet: { shopMoney: { amount: "20.00", currencyCode: "USD" } } });
const fulfillment = { id: "gid://shopify/Fulfillment/432", legacyResourceId: "432", updatedAt: revision, status: "SUCCESS", trackingInfo: [{ company: "USPS", number: "TRACK-1" }] };
const detail = () => ({ id: gid, legacyResourceId: id, name: "#123", createdAt: "2026-09-04T10:00:00Z", updatedAt: revision, cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "PARTIALLY_FULFILLED", currentTotalPriceSet: { shopMoney: { amount: "60.00", currencyCode: "USD" } }, lineItems: conn([line(987)]), fulfillments: [fulfillment] });
type Variables = Record<string, any>;
function transport(override?: (operation: string, variables: Variables) => unknown) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const operation = query.match(/(?:query|mutation) (\w+)/)[1];
    const extra = override?.(operation, variables);
    if (extra !== undefined) return new Response(JSON.stringify(extra));
    const data = operation === "PackProofOrders" ? { orders: conn([{ id: gid, updatedAt: revision }]) }
      : operation === "PackProofOrder" ? { order: detail() }
      : operation === "PackProofOrderRevision" ? { order: { id: gid, updatedAt: revision } }
      : operation === "PackProofFulfillmentLines" ? { node: { id: fulfillment.id, updatedAt: revision, fulfillmentLineItems: conn([{ id: "gid://shopify/FulfillmentLineItem/1", quantity: 2, lineItem: { id: line(987).id } }]) } }
      : operation === "PackProofShopIdentity" ? { shop: { id: "gid://shopify/Shop/21", name: "Store", myshopifyDomain: input.shop } }
      : operation === "PackProofUninstall" ? { appUninstall: { app: { id: "gid://shopify/App/1" }, userErrors: [] } }
      : undefined;
    if (!data) throw new Error(`Unexpected operation ${operation}`);
    return new Response(JSON.stringify({ data }));
  });
}

describe("Shopify Admin GraphQL transport", () => {
  it("keeps exact legacy identities, physical quantities and fulfillment links without customer PII", async () => {
    const fetcher = transport(), progress = vi.fn(async () => {});
    const page = await createHttpShopifyClient(fetcher).listOrdersPage!({ ...input, onProgress: progress });
    expect(page).toMatchObject({ cursor: null, orders: [{ id, customer: null, updatedAt: revision, lineItems: [{ id: "987", remainingQuantity: 1, variantTitle: "Blue" }], fulfillments: [{ id: "432", trackingNumber: "TRACK-1", lineItems: [{ id: "987", quantity: 2 }] }] }] });
    expect(progress).toHaveBeenCalledTimes(fetcher.mock.calls.length * 2);
    for (const [url, request] of fetcher.mock.calls) {
      expect(url).toBe("https://store.myshopify.com/admin/api/2026-07/graphql.json");
      expect(request).toMatchObject({ method: "POST", redirect: "error", headers: { "X-Shopify-Access-Token": input.accessToken } });
      expect(String(request?.body)).not.toMatch(/customer|shippingAddress|billingAddress/);
    }
    expect(SHOPIFY_SCOPES).toEqual(["read_orders"]);
  });

  it("preserves the bounded query across opaque cursor pages and restarts existing REST checkpoints", async () => {
    const fetcher = transport((op, vars) => op === "PackProofOrders" ? { data: { orders: vars.after ? conn([]) : conn([{ id: gid, updatedAt: revision }], "opaque+provider/cursor") } } : undefined);
    const client = createHttpShopifyClient(fetcher);
    const first = await client.listOrdersPage!({ ...input, cursor: "legacy-rest-page-info", limit: 250 });
    expect(first.cursor).toMatch(/^shopify-graphql-v1:/);
    const second = await client.listOrdersPage!({ ...input, updatedSince: "2026-08-01", updatedUntil: "2026-09-06", cursor: first.cursor });
    expect(second).toEqual({ orders: [], cursor: null });
    const requests = fetcher.mock.calls.map(([, i]) => JSON.parse(String(i?.body))).filter(r => r.query.includes("query PackProofOrders("));
    expect(requests[0].variables).toMatchObject({ first: 10, after: null });
    expect(requests[1].variables.after).toBe("opaque+provider/cursor");
    expect(requests[1].variables.query).toBe(requests[0].variables.query);
    expect(requests[0].variables.query).toBe("created_at:>='2026-07-07T12:00:00.000Z' updated_at:>='2026-07-07T12:00:00.000Z' updated_at:<='2026-09-05T12:00:00.000Z'");
    await expect(client.listOrdersPage!({ ...input, shop: "different.myshopify.com", cursor: first.cursor })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("fully drains both nested connections before returning one order revision", async () => {
    const fetcher = transport((op, vars) => {
      if (op === "PackProofOrder") return { data: { order: { ...detail(), lineItems: conn(Array.from({ length: 100 }, (_, i) => line(i + 1)), "line-page-2") } } };
      if (op === "PackProofOrderLines") { expect(vars.after).toBe("line-page-2"); return { data: { order: { id: gid, updatedAt: revision, lineItems: conn([line(101)]) } } }; }
      if (op === "PackProofFulfillmentLines") return { data: { node: { id: fulfillment.id, updatedAt: revision, fulfillmentLineItems: conn([{ id: `gid://shopify/FulfillmentLineItem/${vars.after ? 2 : 1}`, quantity: 1, lineItem: { id: line(vars.after ? 101 : 1).id } }], vars.after ? null : "fulfillment-page-2") } } };
    });
    const result = await createHttpShopifyClient(fetcher).listOrdersPage!(input);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].lineItems).toHaveLength(101);
    expect(result.orders[0].fulfillments?.[0].lineItems).toEqual([{ id: "1", quantity: 1 }, { id: "101", quantity: 1 }]);
  });

  it("does not return a partial order when a nested connection repeats its cursor", async () => {
    const fetcher = transport(op => op === "PackProofOrder" ? { data: { order: { ...detail(), lineItems: conn([line(1)], "loop") } } }
      : op === "PackProofOrderLines" ? { data: { order: { id: gid, updatedAt: revision, lineItems: conn([line(2)], "loop") } } } : undefined);
    await expect(createHttpShopifyClient(fetcher).listOrdersPage!(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("retries if the provider changes the order during hydration", async () => {
    const fetcher = transport(op => op === "PackProofOrderRevision" ? { data: { order: { id: gid, updatedAt: "2026-09-05T11:01:00Z" } } } : undefined);
    await expect(createHttpShopifyClient(fetcher).listOrdersPage!(input)).rejects.toMatchObject({ code: "PROVIDER_TEMPORARILY_UNAVAILABLE", retryable: true });
  });

  it.each([["THROTTLED", "PROVIDER_RATE_LIMITED", true], ["ACCESS_DENIED", "PROVIDER_AUTH_FAILED", false], ["INTERNAL_SERVER_ERROR", "PROVIDER_TEMPORARILY_UNAVAILABLE", true]])("handles HTTP-200 GraphQL %s without accepting partial data", async (source, code, retryable) => {
    const fetcher = transport(() => ({ data: { orders: conn([]) }, errors: [{ message: "provider detail must not escape", extensions: { code: source } }] }));
    await expect(createHttpShopifyClient(fetcher).listOrdersPage!(input)).rejects.toMatchObject({ code, retryable });
  });

  it("uses GraphQL for shop identity and disconnect and rejects mismatched identity", async () => {
    const client = createHttpShopifyClient(transport());
    expect(await client.getShop(input)).toEqual({ shopId: "21", name: "Store", myshopifyDomain: input.shop, email: null });
    await client.revoke(input);
    const bad = createHttpShopifyClient(transport(() => ({ data: { shop: { id: "gid://shopify/Shop/21", myshopifyDomain: "another.myshopify.com" } } })));
    await expect(bad.getShop(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("fences a stopped worker before it can make another provider request", async () => {
    const fetcher = transport(), onProgress = vi.fn(async () => { throw new Error("lease lost"); });
    await expect(createHttpShopifyClient(fetcher).listOrdersPage!({ ...input, onProgress })).rejects.toThrow("lease lost");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Shopify GraphQL normalized eligibility", () => {
  it("removes refunded or edited-away quantities from the packing checklist", async () => {
    const fetcher = transport(op => op === "PackProofOrder" ? { data: { order: { ...detail(), lineItems: conn([{ ...line(1), currentQuantity: 0 }, { ...line(2), currentQuantity: 2 }]) } } } : undefined);
    const adapter = createShopifyCommerceAdapter(createHttpShopifyClient(fetcher));
    const result = await adapter.listFulfillmentOrders({ connection: { external_account_reference: "store" } as IntegrationConnectionRow, credentials: { material: { shop: input.shop, accessToken: input.accessToken } } as any, updatedSince: input.updatedSince, updatedUntil: input.updatedUntil });
    expect(result.orders[0].items).toHaveLength(1);
    expect(result.orders[0].items[0]).toMatchObject({ externalItemId: "2", quantity: 2 });
  });
  it.each([["PARTIALLY_FULFILLED", false, "IN_PROGRESS"], ["ON_HOLD", true, "AWAITING_FULFILLMENT"], ["FULFILLED", false, "FULFILLED"]])("maps %s while keeping the canonical numeric order identity", async (status, held, expected) => {
    const fetcher = transport(op => op === "PackProofOrder" ? { data: { order: { ...detail(), displayFulfillmentStatus: status } } } : undefined);
    const adapter = createShopifyCommerceAdapter(createHttpShopifyClient(fetcher));
    const result = await adapter.listFulfillmentOrders({ connection: { external_account_reference: "store" } as IntegrationConnectionRow, credentials: { material: { shop: input.shop, accessToken: input.accessToken } } as any, updatedSince: input.updatedSince, updatedUntil: input.updatedUntil });
    expect(result.orders[0]).toMatchObject({ externalOrderId: id, externalAccountReference: "store", fulfillmentState: expected, onHold: held, requiresPhysicalFulfillment: true });
  });
});
