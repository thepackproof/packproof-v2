import { describe, expect, it } from "vitest";
import { createHttpShopifyClient } from "../src/integrations/shopify/client.js";
import { createScriptedFetch } from "./fixtures/connected-accounts.js";
import { SHOPIFY_API_VERSION } from "../src/integrations/shopify/constants.js";

const input = { shop: "test-shop.myshopify.com", accessToken: "fixture-token", updatedUntil: "2026-09-05T13:00:00Z" };
const updatedAt = "2026-09-05T12:00:00.000Z";
const orderId = "5678901234567";
const page = (ids: string[], cursor: string | null = null) => ({
  nodes: ids.map(id => ({ id: `gid://shopify/Order/${id}`, updatedAt })),
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
function order(id: string, legacyResourceId: unknown = id) {
  return {
    id: `gid://shopify/Order/${id}`, legacyResourceId, name: "#1001", createdAt: updatedAt, updatedAt,
    cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED",
    currentTotalPriceSet: { shopMoney: { amount: "25.00", currencyCode: "USD" } },
    fulfillments: [], lineItems: {
      nodes: [{ id: "gid://shopify/LineItem/3456789012345", title: "Card", sku: null, quantity: 1, currentQuantity: 1,
        unfulfilledQuantity: 1, variantTitle: null, requiresShipping: true,
        originalUnitPriceSet: { shopMoney: { amount: "25.00", currencyCode: "USD" } } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}
function graphqlFetch(options: {
  onRequest?: (url: string, request: RequestInit | undefined, variables: Record<string, unknown>) => void;
  orders?: (after: unknown) => ReturnType<typeof page>;
  legacyId?: unknown;
} = {}) {
  return createScriptedFetch((url, request) => {
    const { query, variables } = JSON.parse(String(request?.body));
    options.onRequest?.(url, request, variables);
    const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    if (operation === "PackProofShopIdentity") return Response.json({ data: { shop: { id: "gid://shopify/Shop/123456789", name: "Test shop", myshopifyDomain: input.shop } } });
    if (operation === "PackProofOrders") return Response.json({ data: { orders: options.orders?.(variables.after) ?? page([orderId]) } });
    const id = String(variables.id).split("/").at(-1)!;
    if (operation === "PackProofOrder") return Response.json({ data: { order: order(id, options.legacyId ?? id) } });
    if (operation === "PackProofOrderRevision") return Response.json({ data: { order: { id: variables.id, updatedAt } } });
    throw new Error(`Unexpected GraphQL operation ${operation}`);
  });
}

describe("Shopify GraphQL identity and cursor normalization", () => {
  it("preserves numeric shop, order and item identity through GraphQL without requesting buyer personal data", async () => {
    const queries: string[] = [];
    const client = createHttpShopifyClient(graphqlFetch({ onRequest: (_url, init) => queries.push(JSON.parse(String(init?.body)).query) }));
    expect((await client.getShop(input)).shopId).toBe("123456789");
    const orders = await client.listOrders(input);
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe(orderId);
    expect(orders[0].customer).toBeNull();
    expect(orders[0].lineItems[0].id).toBe("3456789012345");
    expect(queries.join("\n")).not.toMatch(/customer|shippingAddress|billingAddress/);
  });

  it("rejects imprecise numeric legacy identities rather than binding a rounded order ID", async () => {
    const client = createHttpShopifyClient(graphqlFetch({ legacyId: Number.MAX_SAFE_INTEGER + 1 }));
    await expect(client.listOrders(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("uses the opaque next cursor while preserving the frozen GraphQL search filters", async () => {
    const requests: Array<{ url: string; query: string; variables: Record<string, unknown>; request?: RequestInit }> = [];
    const client = createHttpShopifyClient(graphqlFetch({
      orders: after => after ? page(["1002"]) : page(["1001"], "opaque+cursor="),
      onRequest: (url, request, variables) => requests.push({ url, query: JSON.parse(String(request?.body)).query, variables, request }),
    }));
    const first = await client.listOrdersPage!(input);
    const second = await client.listOrdersPage!({ ...input, cursor: first.cursor });
    expect(first.cursor).toMatch(/^shopify-graphql-v1:/);
    expect(second.cursor).toBeNull();
    expect(second.orders[0].id).toBe("1002");
    const pages = requests.filter(r => r.query.includes("query PackProofOrders("));
    expect(pages[0].variables.after).toBeNull();
    expect(pages[1].variables.after).toBe("opaque+cursor=");
    expect(pages[1].variables.query).toBe(pages[0].variables.query);
    expect(String(pages[0].variables.query)).toContain("updated_at:");
    for (const request of requests) {
      expect(request.url).toBe(`https://${input.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
      expect(request.request).toMatchObject({ method: "POST", redirect: "error" });
    }
  });

  it("rejects continuation state from another merchant before sending that merchant a token", async () => {
    const requests: string[] = [];
    const client = createHttpShopifyClient(graphqlFetch({ orders: () => page([orderId], "next"), onRequest: url => requests.push(url) }));
    const first = await client.listOrdersPage!(input);
    const before = requests.length;
    await expect(client.listOrdersPage!({ ...input, shop: "other-shop.myshopify.com", cursor: first.cursor }))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(requests).toHaveLength(before);
  });
});
