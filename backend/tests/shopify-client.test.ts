import { describe, expect, it } from "vitest";
import { createHttpShopifyClient } from "../src/integrations/shopify/client.js";
import { createScriptedFetch } from "./fixtures/connected-accounts.js";
import { SHOPIFY_API_VERSION } from "../src/integrations/shopify/constants.js";

describe("Shopify REST identity normalization", () => {
  it("preserves numeric shop, order, customer and item IDs from real-shaped responses", async () => {
    const client = createHttpShopifyClient(createScriptedFetch((url) => Response.json(
      url.endsWith("/shop.json")
        ? { shop: { id: 123456789, name: "Test shop", myshopify_domain: "test-shop.myshopify.com" } }
        : { orders: [{
            id: 5678901234567,
            name: "#1001",
            created_at: "2026-09-05T12:00:00Z",
            financial_status: "paid",
            customer: { id: 2345678901234, first_name: "Test", last_name: "Buyer" },
            line_items: [{ id: 3456789012345, title: "Card", quantity: 1, price: "25.00", requires_shipping: true }],
          }] },
    )));
    const input = { shop: "test-shop.myshopify.com", accessToken: "fixture-token" };
    expect((await client.getShop(input)).shopId).toBe("123456789");
    const { orders } = await client.listOrders(input);
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe("5678901234567");
    expect(orders[0].customer?.id).toBe("2345678901234");
    expect(orders[0].lineItems[0].id).toBe("3456789012345");
  });

  it("rejects imprecise numeric identities rather than binding a rounded order ID", async () => {
    const client = createHttpShopifyClient(createScriptedFetch(() => Response.json({ orders: [{ id: Number.MAX_SAFE_INTEGER + 1 }] })));
    await expect(client.listOrders({ shop: "test-shop.myshopify.com", accessToken: "fixture-token" }))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("follows only the next cursor on the same shop and omits initial filters on later pages", async () => {
    const requests: URL[] = [];
    const client = createHttpShopifyClient(createScriptedFetch((raw) => {
      const url = new URL(raw);
      requests.push(url);
      if (!url.searchParams.has("page_info")) {
        return Response.json({ orders: [{ id: 1001 }] }, { headers: {
          Link: `<https://test-shop.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/orders.json?page_info=opaque%2Bcursor%3D&limit=50>; rel="next"`,
        } });
      }
      return Response.json({ orders: [{ id: 1002 }] }, { headers: {
        Link: `<https://test-shop.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/orders.json?page_info=previous&limit=50>; rel="previous"`,
      } });
    }));
    const input = { shop: "test-shop.myshopify.com", accessToken: "fixture-token" };
    const first = await client.listOrders(input);
    const second = await client.listOrders({ ...input, cursor: first.cursor });
    expect(first.cursor).toBe("opaque+cursor=");
    expect(second.cursor).toBeNull();
    expect(second.orders[0].id).toBe("1002");
    expect(requests[0].pathname).toContain("/2026-07/");
    expect(requests[0].searchParams.get("status")).toBe("any");
    expect(requests[1].searchParams.get("status")).toBeNull();
    expect(requests[1].searchParams.get("page_info")).toBe("opaque+cursor=");
  });

  it("rejects next-page links that target another merchant or host", async () => {
    const client = createHttpShopifyClient(createScriptedFetch(() => Response.json({ orders: [] }, { headers: {
      Link: `<https://other-shop.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/orders.json?page_info=stolen>; rel="next"`,
    } })));
    await expect(client.listOrders({ shop: "test-shop.myshopify.com", accessToken: "fixture-token" }))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });
});
