import { providerAuthFailed, providerRateLimited, providerResponseInvalid, providerTemporarilyUnavailable } from "../../domain/integration-errors.js";
import { asNumber, asRecord, asString, mapOAuthHttpError, oauthJson, readJson, type FetchLike } from "../connected-accounts/http.js";
import { shopifyAdminApiUrl, shopifyTokenUrl } from "./constants.js";
import { FULFILLMENT_LINES_QUERY, ORDER_LINES_QUERY, ORDER_QUERY, ORDER_REVISION_QUERY, ORDERS_QUERY, SHOP_IDENTITY_QUERY, UNINSTALL_MUTATION } from "./queries.js";
import { normalizeShopifyShop } from "./shop.js";
import type { ShopifyClient, ShopifyOrder, ShopifyOrderPageInput } from "./types.js";

const CURSOR_PREFIX = "shopify-graphql-v1:";
const RECENT_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
type RequestContext = { shop: string; accessToken: string; onProgress?: () => Promise<void> };

export function createHttpShopifyClient(fetchImpl: FetchLike = fetch): ShopifyClient {
  return {
    async exchangeAuthorizationCode(input) {
      const record = asRecord(await oauthJson(fetchImpl, {
        url: shopifyTokenUrl(normalizeShopifyShop(input.shop)), method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code }),
      }));
      const accessToken = asString(record.access_token);
      if (!accessToken) throw providerResponseInvalid();
      return { accessToken, scope: asString(record.scope) ?? "" };
    },
    async getShop(input) {
      const shop = asRecord((await graphql(fetchImpl, input, SHOP_IDENTITY_QUERY)).shop);
      const domain = requiredString(shop.myshopifyDomain);
      if (domain !== normalizeShopifyShop(input.shop)) throw providerResponseInvalid();
      return { shopId: numericGid(shop.id, "Shop"), name: asString(shop.name), myshopifyDomain: domain, email: null };
    },
    async listOrders(input) { return (await listOrderPage(fetchImpl, input)).orders; },
    async listOrdersPage(input) { return listOrderPage(fetchImpl, input); },
    async revoke(input) {
      const payload = asRecord((await graphql(fetchImpl, input, UNINSTALL_MUTATION)).appUninstall);
      if (!Array.isArray(payload.userErrors) || payload.userErrors.length) throw providerResponseInvalid();
    },
  };
}

async function listOrderPage(fetchImpl: FetchLike, input: ShopifyOrderPageInput) {
  const state = pageState(input);
  // Hydration is bounded per outer page; nested connections are fully drained.
  const data = await graphql(fetchImpl, input, ORDERS_QUERY, {
    first: Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 10), after: state.after, query: searchQuery(state.since, state.until),
  });
  const page = connection(data.orders);
  const orders: ShopifyOrder[] = [];
  for (const node of page.nodes) orders.push(await hydrateOrder(fetchImpl, input, asRecord(node)));
  return { orders, cursor: page.cursor ? CURSOR_PREFIX + Buffer.from(JSON.stringify({
    shop: normalizeShopifyShop(input.shop), after: page.cursor, since: state.since, until: state.until,
  })).toString("base64url") : null };
}

async function hydrateOrder(fetchImpl: FetchLike, input: RequestContext, summary: Record<string, unknown>): Promise<ShopifyOrder> {
  const id = requiredString(summary.id), revision = requiredDate(summary.updatedAt);
  numericGid(id, "Order");
  const record = asRecord((await graphql(fetchImpl, input, ORDER_QUERY, { id })).order);
  requireRevision(record, id, revision);
  const itemPage = connection(record.lineItems), items = [...itemPage.nodes];
  let after = itemPage.cursor;
  const seen = new Set<string>();
  while (after) {
    requireNewCursor(seen, after);
    const next = asRecord((await graphql(fetchImpl, input, ORDER_LINES_QUERY, { id, after })).order);
    requireRevision(next, id, revision);
    const page = connection(next.lineItems);
    items.push(...page.nodes); after = page.cursor;
  }
  const lineItems = items.map(parseLineItem);
  requireUniqueIds(lineItems);
  if (!Array.isArray(record.fulfillments)) throw providerResponseInvalid();
  const fulfillments: NonNullable<ShopifyOrder["fulfillments"]> = [];
  let trackingCompany: string | null = null, trackingNumber: string | null = null;
  for (const value of record.fulfillments) {
    const fulfillment = asRecord(value), fid = requiredString(fulfillment.id);
    const fRevision = requiredDate(fulfillment.updatedAt), legacyId = numericId(fulfillment.legacyResourceId);
    if (numericGid(fid, "Fulfillment") !== legacyId) throw providerResponseInvalid();
    // Cancelled/error fulfillment attempts do not assert shipped packages.
    if (["CANCELLED", "ERROR", "FAILURE"].includes(requiredString(fulfillment.status))) continue;
    if (!Array.isArray(fulfillment.trackingInfo)) throw providerResponseInvalid();
    const tracking = fulfillment.trackingInfo.map(asRecord);
    const firstTracking = tracking.find(t => asString(t.number)) ?? tracking[0] ?? {};
    const number = asString(firstTracking.number);
    const fItems: Array<{ id: string; quantity: number | null }> = [];
    let fAfter: string | null = null;
    const fSeen = new Set<string>();
    do {
      if (fAfter) requireNewCursor(fSeen, fAfter);
      const next = asRecord((await graphql(fetchImpl, input, FULFILLMENT_LINES_QUERY, { id: fid, after: fAfter })).node);
      requireRevision(next, fid, fRevision);
      const page = connection(next.fulfillmentLineItems);
      fItems.push(...page.nodes.map(value => {
        const row = asRecord(value);
        return { id: numericGid(asRecord(row.lineItem).id, "LineItem"), quantity: nonnegativeInteger(row.quantity, true) };
      }));
      fAfter = page.cursor;
    } while (fAfter);
    requireUniqueIds(fItems);
    fulfillments.push({ id: legacyId, trackingNumber: number, lineItems: fItems });
    if (!trackingNumber && number) { trackingNumber = number; trackingCompany = asString(firstTracking.company); }
  }
  requireUniqueIds(fulfillments);
  // Shopify has no transactional snapshot across connections: retry a changing
  // order instead of assigning a mixed revision to an immutable source record.
  const finalRevision = asRecord((await graphql(fetchImpl, input, ORDER_REVISION_QUERY, { id })).order);
  requireRevision(finalRevision, id, revision);
  const legacyId = numericId(record.legacyResourceId);
  if (numericGid(id, "Order") !== legacyId) throw providerResponseInvalid();
  const money = asRecord(asRecord(record.currentTotalPriceSet).shopMoney);
  const fulfillmentStatus = requiredString(record.displayFulfillmentStatus);
  return {
    id: legacyId, name: asString(record.name), createdAt: requiredDate(record.createdAt), updatedAt: revision,
    cancelledAt: record.cancelledAt == null ? null : requiredDate(record.cancelledAt),
    fulfillmentHolds: fulfillmentStatus === "ON_HOLD", fulfillmentStatus,
    financialStatus: asString(record.displayFinancialStatus), totalPrice: asString(money.amount), currency: asString(money.currencyCode),
    // Buyer personal data is unnecessary to start packing and is not requested.
    customer: null, lineItems, fulfillments, trackingCompany, trackingNumber,
  };
}

function parseLineItem(value: unknown): ShopifyOrder["lineItems"][number] {
  const row = asRecord(value), money = asRecord(asRecord(row.originalUnitPriceSet).shopMoney);
  if (typeof row.requiresShipping !== "boolean") throw providerResponseInvalid();
  return { id: numericGid(row.id, "LineItem"), title: asString(row.title), sku: asString(row.sku),
    quantity: nonnegativeInteger(row.quantity), currentQuantity: nonnegativeInteger(row.currentQuantity),
    remainingQuantity: nonnegativeInteger(row.unfulfilledQuantity), price: asString(money.amount), variantTitle: asString(row.variantTitle),
    requiresShipping: row.requiresShipping };
}

async function graphql(fetchImpl: FetchLike, input: RequestContext, query: string, variables: Record<string, unknown> = {}) {
  await input.onProgress?.();
  let response: Response;
  try {
    response = await fetchImpl(shopifyAdminApiUrl(normalizeShopifyShop(input.shop), "/graphql.json"), {
      method: "POST", signal: AbortSignal.timeout(20_000), redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Shopify-Access-Token": input.accessToken },
      body: JSON.stringify({ query, variables }),
    });
  } catch { throw providerTemporarilyUnavailable(); }
  if (!response.ok) mapOAuthHttpError(response.status);
  const payload = asRecord(await readJson(response));
  if (Array.isArray(payload.errors) && payload.errors.length) {
    const codes = payload.errors.map(e => asString(asRecord(asRecord(e).extensions).code));
    if (codes.some(c => c === "ACCESS_DENIED" || c === "UNAUTHORIZED")) throw providerAuthFailed();
    if (codes.includes("THROTTLED")) throw providerRateLimited();
    if (codes.includes("INTERNAL_SERVER_ERROR") || codes.includes("SERVICE_UNAVAILABLE")) throw providerTemporarilyUnavailable();
    throw providerResponseInvalid();
  }
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw providerResponseInvalid();
  await input.onProgress?.();
  return asRecord(payload.data);
}

function connection(value: unknown): { nodes: unknown[]; cursor: string | null } {
  const record = asRecord(value), page = asRecord(record.pageInfo);
  if (!Array.isArray(record.nodes) || typeof page.hasNextPage !== "boolean") throw providerResponseInvalid();
  const cursor = page.hasNextPage ? requiredString(page.endCursor) : null;
  if (cursor && !record.nodes.length) throw providerResponseInvalid();
  return { nodes: record.nodes, cursor };
}

function pageState(input: ShopifyOrderPageInput): { after: string | null; since: string; until: string } {
  // A persisted REST page_info cannot be used with GraphQL. Restart its frozen
  // window; canonical order IDs and source fingerprints make this idempotent.
  if (input.cursor?.startsWith(CURSOR_PREFIX)) {
    let value: unknown;
    try { value = JSON.parse(Buffer.from(input.cursor.slice(CURSOR_PREFIX.length), "base64url").toString()); }
    catch { throw providerResponseInvalid(); }
    const record = asRecord(value), since = requiredDate(record.since), until = requiredDate(record.until);
    if (record.shop !== normalizeShopifyShop(input.shop) || Date.parse(since) > Date.parse(until) || Date.parse(until) - Date.parse(since) > RECENT_WINDOW_MS)
      throw providerResponseInvalid();
    return { after: requiredString(record.after), since, until };
  }
  const until = requiredDate(input.updatedUntil ?? new Date().toISOString());
  const floor = Date.parse(until) - RECENT_WINDOW_MS;
  const since = new Date(Math.max(floor, input.updatedSince ? Date.parse(requiredDate(input.updatedSince)) : floor)).toISOString();
  if (Date.parse(since) > Date.parse(until)) throw providerResponseInvalid();
  return { after: null, since, until };
}

function searchQuery(since: string, until: string): string {
  const createdAfter = new Date(Date.parse(until) - RECENT_WINDOW_MS).toISOString();
  return `created_at:>='${createdAfter}' updated_at:>='${since}' updated_at:<='${until}'`;
}
function requiredString(value: unknown): string { const result = asString(value); if (!result) throw providerResponseInvalid(); return result; }
function requiredDate(value: unknown): string {
  const result = requiredString(value); if (!Number.isFinite(Date.parse(result))) throw providerResponseInvalid(); return new Date(result).toISOString();
}
function numericId(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : requiredString(value);
  if (!/^\d+$/.test(id)) throw providerResponseInvalid(); return id;
}
function numericGid(value: unknown, type: string): string {
  const gid = requiredString(value), prefix = `gid://shopify/${type}/`;
  if (!gid.startsWith(prefix)) throw providerResponseInvalid(); return numericId(gid.slice(prefix.length));
}
function nonnegativeInteger(value: unknown, nullable = false): number | null {
  if (nullable && value == null) return null;
  const number = asNumber(value); if (number == null || !Number.isSafeInteger(number) || number < 0) throw providerResponseInvalid(); return number;
}
function requireRevision(record: Record<string, unknown>, id: string, revision: string) {
  if (record.id !== id || requiredDate(record.updatedAt) !== revision) throw providerTemporarilyUnavailable();
}
function requireNewCursor(seen: Set<string>, cursor: string) {
  if (seen.has(cursor) || seen.size >= 250) throw providerResponseInvalid(); seen.add(cursor);
}
function requireUniqueIds(rows: Array<{ id: string | null }>) {
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw providerResponseInvalid();
}
