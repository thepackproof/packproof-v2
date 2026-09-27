import { DomainError } from "../../domain/errors.js";
import { providerAuthFailed, providerResponseInvalid, providerTemporarilyUnavailable } from "../../domain/integration-errors.js";
import { asNumber, asRecord, asString, mapOAuthHttpError, readJson, type FetchLike } from "../connected-accounts/http.js";
import { rateLimitDelay } from "../rate-limit-delay.js";
import { shopifyAdminApiUrl } from "./constants.js";
import { normalizeShopifyShop } from "./shop.js";

const ORDER_TOPICS = {
  "orders/create": "ORDERS_CREATE", "orders/updated": "ORDERS_UPDATED", "orders/paid": "ORDERS_PAID",
  "orders/cancelled": "ORDERS_CANCELLED", "orders/fulfilled": "ORDERS_FULFILLED",
  "fulfillments/create": "FULFILLMENTS_CREATE", "fulfillments/update": "FULFILLMENTS_UPDATE",
} as const;
const FULFILLMENT_ORDER_TOPICS = {
  "fulfillment_orders/order_routing_complete": "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE",
  "fulfillment_orders/hold_released": "FULFILLMENT_ORDERS_HOLD_RELEASED",
  "fulfillment_orders/placed_on_hold": "FULFILLMENT_ORDERS_PLACED_ON_HOLD",
  "fulfillment_orders/scheduled_fulfillment_order_ready": "FULFILLMENT_ORDERS_SCHEDULED_FULFILLMENT_ORDER_READY",
  "fulfillment_orders/rescheduled": "FULFILLMENT_ORDERS_RESCHEDULED",
  "fulfillment_orders/moved": "FULFILLMENT_ORDERS_MOVED",
  "fulfillment_orders/split": "FULFILLMENT_ORDERS_SPLIT",
  "fulfillment_orders/merged": "FULFILLMENT_ORDERS_MERGED",
} as const;
export const SHOPIFY_COMMERCE_WEBHOOK_TOPICS = Object.freeze([...Object.keys(ORDER_TOPICS), ...Object.keys(FULFILLMENT_ORDER_TOPICS)]);
export const SHOPIFY_PRIVACY_WEBHOOK_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;

export const SHOPIFY_WEBHOOK_SUBSCRIPTIONS_QUERY = `query PackProofWebhookSubscriptions($after: String, $topics: [WebhookSubscriptionTopic!], $uri: String!) {
  webhookSubscriptions(first: 100, after: $after, topics: $topics, uri: $uri) {
    nodes { id topic uri format filter }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const SHOPIFY_WEBHOOK_CREATE_MUTATION = `mutation PackProofWebhookCreate($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
    webhookSubscription { id topic uri format filter }
    userErrors { field message }
  }
}`;
export const SHOPIFY_WEBHOOK_UPDATE_MUTATION = `mutation PackProofWebhookUpdate($id: ID!, $subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $subscription) {
    webhookSubscription { id topic uri format filter }
    userErrors { field message }
  }
}`;

export interface ShopifyWebhookRegistrationInput {
  shop: string;
  accessToken: string;
  callbackUrl: string;
  scopes: readonly string[];
  onProgress?: () => Promise<void>;
}
interface Subscription { id: string; topic: string; uri: string; format: string; filter: string | null }

/** HTTPS endpoint is derived from configured server OAuth callback, never a request host header. */
export function shopifyWebhookCallbackUrl(redirectUri: string): string {
  let url: URL;
  try { url = new URL(redirectUri); } catch { throw registrationInvalid(); }
  const callbackPath = "/oauth/shopify/callback";
  if (!url.pathname.endsWith(callbackPath)) throw registrationInvalid();
  // Public API gateways can mount the backend under /api; preserve that prefix.
  url.pathname = `${url.pathname.slice(0, -callbackPath.length)}/integrations/webhooks/shopify`;
  url.search = ""; url.hash = "";
  return validateCallbackUrl(url.toString());
}

/** Scopes are checked locally and by Shopify. No fulfillment-write permission is necessary. */
export function shopifyWebhookTopicsForScopes(scopes: readonly string[]): Record<string, string> {
  const canRead = (name: string) => scopes.includes(`read_${name}`) || scopes.includes(`write_${name}`);
  return {
    "app/uninstalled": "APP_UNINSTALLED",
    ...(canRead("orders") ? ORDER_TOPICS : {}),
    ...(["merchant_managed_fulfillment_orders", "assigned_fulfillment_orders", "third_party_fulfillment_orders", "marketplace_fulfillment_orders"].some(canRead)
      ? FULFILLMENT_ORDER_TOPICS : {}),
  };
}

/**
 * Reconcile shop-scoped subscriptions after credentials are persisted. Safe to rerun
 * after a partially successful installation, reconnect, network error, or HTTP 429.
 * A create race is accepted only after an authoritative matching subscription read.
 * App-scoped TOML subscriptions are not exposed by this query; use only this
 * registration mechanism for these topics to avoid duplicate subscriptions.
 */
export async function ensureShopifyWebhookSubscriptions(input: ShopifyWebhookRegistrationInput, fetchImpl: FetchLike = fetch): Promise<{topics: string[]; subscriptionIds: string[]}> {
  const callbackUrl = validateCallbackUrl(input.callbackUrl), topicMap = shopifyWebhookTopicsForScopes(input.scopes);
  const subscriptions = await listSubscriptions();
  const ids: string[] = [];
  for (const [topic, enumTopic] of Object.entries(topicMap)) {
    const matches = (sub: Subscription) => sub.topic === enumTopic && sub.uri === callbackUrl && sub.format === "JSON" && !sub.filter;
    const existing = subscriptions.find(matches);
    if (existing) { ids.push(existing.id); continue; }
    // A filtered subscription could silently miss unpaid -> paid or hold release
    // changes. Repair only our exact callback URI, never another endpoint.
    const repair = subscriptions.find(sub => sub.topic === enumTopic && sub.uri === callbackUrl);
    const field = repair ? "webhookSubscriptionUpdate" : "webhookSubscriptionCreate";
    const subscription = { uri: callbackUrl, format: "JSON", filter: null,
      // The receiver only needs the invalidation. Avoid transporting order PII.
      includeFields: topic.startsWith("fulfillment_orders/") ? [] : ["id"] };
    const result = asRecord((await graphql(repair ? SHOPIFY_WEBHOOK_UPDATE_MUTATION : SHOPIFY_WEBHOOK_CREATE_MUTATION,
      { ...(repair ? { id: repair.id } : { topic: enumTopic }), subscription }))[field]);
    if (!Array.isArray(result.userErrors)) throw providerResponseInvalid();
    if (result.userErrors.length) {
      // Do not equate all userErrors with "already exists": verify the state.
      const duplicate = result.userErrors.some(value => /already|taken|duplicate/i.test(asString(asRecord(value).message) ?? ""));
      const concurrent = duplicate ? (await listSubscriptions()).find(matches) : null;
      if (!concurrent) throw registrationInvalid();
      ids.push(concurrent.id); continue;
    }
    const created = parseSubscription(result.webhookSubscription);
    if (!matches(created)) throw providerResponseInvalid();
    ids.push(created.id); subscriptions.push(created);
  }
  return { topics: Object.keys(topicMap), subscriptionIds: ids };

  async function listSubscriptions(): Promise<Subscription[]> {
    const found: Subscription[] = [], cursors = new Set<string>();
    let after: string | null = null;
    do {
      const page = asRecord((await graphql(SHOPIFY_WEBHOOK_SUBSCRIPTIONS_QUERY, { after, topics: Object.values(topicMap), uri: callbackUrl })).webhookSubscriptions);
      const info = asRecord(page.pageInfo);
      if (!Array.isArray(page.nodes) || typeof info.hasNextPage !== "boolean") throw providerResponseInvalid();
      found.push(...page.nodes.map(parseSubscription));
      after = info.hasNextPage ? asString(info.endCursor) : null;
      if (info.hasNextPage && (!after || !page.nodes.length || cursors.has(after) || cursors.size >= 100)) throw providerResponseInvalid();
      if (after) cursors.add(after);
    } while (after);
    return found;
  }
  async function graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    await input.onProgress?.();
    let response: Response;
    try {
      response = await fetchImpl(shopifyAdminApiUrl(normalizeShopifyShop(input.shop), "/graphql.json"), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Shopify-Access-Token": input.accessToken },
        body: JSON.stringify({ query, variables }),
      });
    } catch { throw providerTemporarilyUnavailable(); }
    if (response.status === 429) throw rateLimitDelay(response.headers.get("retry-after"));
    if (!response.ok) mapOAuthHttpError(response.status);
    const body = asRecord(await readJson(response));
    if (Array.isArray(body.errors) && body.errors.length) {
      const codes = body.errors.map(value => asString(asRecord(asRecord(value).extensions).code));
      if (codes.some(code => code === "ACCESS_DENIED" || code === "UNAUTHORIZED")) throw providerAuthFailed();
      if (codes.includes("THROTTLED")) {
        const cost = asRecord(asRecord(body.extensions).cost), throttle = asRecord(cost.throttleStatus);
        const requested = asNumber(cost.requestedQueryCost), available = asNumber(throttle.currentlyAvailable), restore = asNumber(throttle.restoreRate);
        const delay = requested != null && available != null && restore != null && restore > 0 ? Math.max(1, Math.ceil((requested - available) / restore)) : null;
        throw rateLimitDelay(response.headers.get("retry-after"), delay);
      }
      if (codes.includes("INTERNAL_SERVER_ERROR") || codes.includes("SERVICE_UNAVAILABLE")) throw providerTemporarilyUnavailable();
      throw providerResponseInvalid();
    }
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw providerResponseInvalid();
    await input.onProgress?.();
    return asRecord(body.data);
  }
}

function parseSubscription(value: unknown): Subscription {
  const row = asRecord(value), id = asString(row.id), topic = asString(row.topic), uri = asString(row.uri), format = asString(row.format);
  if (!id?.startsWith("gid://shopify/WebhookSubscription/") || !topic || !uri || !format || (row.filter != null && typeof row.filter !== "string")) throw providerResponseInvalid();
  return { id, topic, uri, format, filter: asString(row.filter) };
}
function validateCallbackUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw registrationInvalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw registrationInvalid();
  return url.toString();
}
function registrationInvalid(): DomainError {
  return new DomainError("SHOPIFY_WEBHOOK_REGISTRATION_FAILED", "Shopify event subscriptions could not be configured. Scheduled order checks remain available.", 502);
}
