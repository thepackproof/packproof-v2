import { providerResponseInvalid } from "../../domain/integration-errors.js";
import {
  asNumber,
  asRecord,
  asString,
  mapOAuthHttpError,
  oauthJson,
  readJson,
  type FetchLike,
} from "../connected-accounts/http.js";
import { shopifyAdminApiUrl, shopifyRevokeUrl, shopifyTokenUrl } from "./constants.js";
import type { ShopifyClient, ShopifyOrder, ShopifyShopIdentity, ShopifyTokenSet } from "./types.js";

export function createHttpShopifyClient(fetchImpl: FetchLike = fetch): ShopifyClient {
  return {
    async exchangeAuthorizationCode(input) {
      const payload = await oauthJson(fetchImpl, {
        url: shopifyTokenUrl(input.shop),
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
        }),
      });
      const record = asRecord(payload);
      const accessToken = asString(record.access_token);
      if (!accessToken) {
        throw providerResponseInvalid();
      }
      return {
        accessToken,
        scope: asString(record.scope) ?? "",
      } satisfies ShopifyTokenSet;
    },
    async getShop(input) {
      const payload = await shopifyJson(fetchImpl, {
        url: shopifyAdminApiUrl(input.shop, "/shop.json"),
        accessToken: input.accessToken,
      });
      const shop = asRecord(asRecord(payload).shop);
      const myshopifyDomain = asString(shop.myshopify_domain) ?? input.shop;
      const shopId = shopifyId(shop.id) ?? asString(shop.myshopify_domain) ?? input.shop;
      return {
        shopId,
        name: asString(shop.name),
        myshopifyDomain,
        email: asString(shop.email),
      } satisfies ShopifyShopIdentity;
    },
    async listOrders(input) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 50);
      const url = new URL(shopifyAdminApiUrl(input.shop, "/orders.json"));
      if (input.cursor) {
        if (input.cursor.length > 4096 || /[\x00-\x1f]/.test(input.cursor)) throw providerResponseInvalid();
        url.searchParams.set("page_info", input.cursor);
      } else url.searchParams.set("status", "any");
      url.searchParams.set("limit", String(limit));
      const response = await fetchImpl(url.toString(), {
        headers: { Accept: "application/json", "X-Shopify-Access-Token": input.accessToken },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await readJson(response);
      if (!response.ok) mapOAuthHttpError(response.status);
      const raw = Array.isArray(asRecord(payload).orders) ? (asRecord(payload).orders as unknown[]) : [];
      return {
        orders: raw.map(parseOrder).filter((order): order is ShopifyOrder => order != null),
        cursor: nextOrderCursor(response.headers.get("link"), url),
      };
    },
    async revoke(input) {
      const response = await fetchImpl(shopifyRevokeUrl(input.shop), {
        method: "DELETE",
        headers: {
          "X-Shopify-Access-Token": input.accessToken,
          Accept: "application/json",
        },
      });
      if (response.status === 404 || response.status === 401) {
        return;
      }
      if (!response.ok && response.status !== 204) {
        mapOAuthHttpError(response.status);
      }
    },
  };
}

async function shopifyJson(
  fetchImpl: FetchLike,
  input: { url: string; accessToken: string },
): Promise<unknown> {
  const response = await fetchImpl(input.url, {
    headers: {
      Accept: "application/json",
      "X-Shopify-Access-Token": input.accessToken,
    },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    mapOAuthHttpError(response.status);
  }
  return payload;
}

function parseOrder(value: unknown): ShopifyOrder | null {
  const record = asRecord(value);
  const id = shopifyId(record.id);
  if (!id) {
    return null;
  }
  const customer = asRecord(record.customer);
  const first = asString(customer.first_name);
  const last = asString(customer.last_name);
  const displayName = [first, last].filter(Boolean).join(" ").trim() || asString(customer.email);
  const items = Array.isArray(record.line_items) ? record.line_items : [];
  const fulfillments = Array.isArray(record.fulfillments) ? record.fulfillments : [];
  let trackingCompany: string | null = null;
  let trackingNumber: string | null = null;
  for (const entry of fulfillments) {
    const fulfillment = asRecord(entry);
    trackingCompany = asString(fulfillment.tracking_company) ?? trackingCompany;
    trackingNumber = asString(fulfillment.tracking_number) ?? trackingNumber;
    if (trackingCompany || trackingNumber) {
      break;
    }
  }
  return {
    id,
    name: asString(record.name),
    createdAt: asString(record.created_at),
    cancelledAt: asString(record.cancelled_at),
    financialStatus: asString(record.financial_status),
    fulfillmentStatus: asString(record.fulfillment_status),
    totalPrice: asString(record.total_price),
    currency: asString(record.currency),
    customer:
      shopifyId(customer.id) || displayName
        ? { id: shopifyId(customer.id), displayName: displayName || null }
        : null,
    lineItems: items.map((item) => {
      const row = asRecord(item);
      return {
        id: shopifyId(row.id),
        title: asString(row.title),
        sku: asString(row.sku),
        quantity: asNumber(row.quantity),
        price: asString(row.price),
        requiresShipping: row.requires_shipping === true ? true : row.requires_shipping === false ? false : null,
      };
    }),
    trackingCompany,
    trackingNumber,
  };
}

function shopifyId(value: unknown): string | null {
  if (typeof value === "number") {
    // REST represents IDs as JSON numbers. Never bind rounded/unsafe identities.
    if (!Number.isSafeInteger(value) || value <= 0) throw providerResponseInvalid();
    return String(value);
  }
  return asString(value);
}

function nextOrderCursor(header: string | null, requested: URL): string | null {
  if (!header) return null;
  const links = header.split(/,\s*(?=<)/);
  for (const link of links) {
    if (!/;\s*rel\s*=\s*"?next"?(?:\s*;|\s*$)/i.test(link)) continue;
    const href = /^\s*<([^>]+)>/.exec(link)?.[1];
    if (!href) throw providerResponseInvalid();
    let next: URL;
    try { next = new URL(href); } catch { throw providerResponseInvalid(); }
    // Never follow an arbitrary provider URL with the merchant's access token.
    if (next.origin !== requested.origin || next.pathname !== requested.pathname ||
        next.username || next.password || next.hash) throw providerResponseInvalid();
    const cursor = next.searchParams.get("page_info");
    if (!cursor || cursor.length > 4096 || /[\x00-\x1f]/.test(cursor)) throw providerResponseInvalid();
    return cursor;
  }
  return null;
}
