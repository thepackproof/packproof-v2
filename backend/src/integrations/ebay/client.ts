import {
  providerResponseInvalid,
} from "../../domain/integration-errors.js";
import { ebayApiBaseUrl, type EbayEnvironment } from "./constants.js";
import { basicAuthHeader, ebayTokenUrl } from "./oauth.js";
import { mapEbayHttpError } from "./credentials.js";
import type {
  EbayClient,
  EbayMoney,
  EbayOrder,
  EbayOrderLineItem,
  EbayOrderList,
  EbayTokenSet,
  EbayUserIdentity,
} from "./types.js";

export function createHttpEbayClient(fetchImpl: typeof fetch = fetch): EbayClient {
  return {
    async exchangeAuthorizationCode(input) {
      return tokenRequest(fetchImpl, input.environment, input.clientId, input.clientSecret, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.ruName,
      });
    },
    async refreshUserToken(input) {
      return tokenRequest(fetchImpl, input.environment, input.clientId, input.clientSecret, {
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      });
    },
    async getUser(input) {
      const payload = await ebayJson(fetchImpl, {
        url: `${ebayApiBaseUrl(input.environment)}/commerce/identity/v1/user/`,
        accessToken: input.accessToken,
      });
      const record = asRecord(payload);
      const userId = asString(record.userId) ?? asString(record.username);
      if (!userId) {
        throw providerResponseInvalid();
      }
      return {
        userId,
        username: asString(record.username),
        accountType: asString(record.accountType),
      } satisfies EbayUserIdentity;
    },
    async listOrders(input) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 50);
      const offset = Math.max(input.offset ?? 0, 0);
      const url = new URL(`${ebayApiBaseUrl(input.environment)}/sell/fulfillment/v1/order`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      const payload = await ebayJson(fetchImpl, {
        url: url.toString(),
        accessToken: input.accessToken,
        marketplaceId: input.marketplaceId,
      });
      return parseOrderList(payload, limit, offset);
    },
    async getOrder(input) {
      const payload = await ebayJson(fetchImpl, {
        url: `${ebayApiBaseUrl(input.environment)}/sell/fulfillment/v1/order/${encodeURIComponent(input.orderId)}`,
        accessToken: input.accessToken,
        marketplaceId: input.marketplaceId,
      });
      const order = parseOrder(payload);
      if (!order) {
        throw providerResponseInvalid();
      }
      return order;
    },
    async revokeUserToken(input) {
      const response = await fetchImpl(ebayTokenRevokeUrl(input.environment), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuthHeader(input.clientId, input.clientSecret),
        },
        body: new URLSearchParams({ token: input.token }).toString(),
      });
      if (!response.ok && response.status !== 400) {
        mapEbayHttpError(response.status);
      }
    },
  };
}

function ebayTokenRevokeUrl(environment: EbayEnvironment): string {
  return `${ebayApiBaseUrl(environment)}/identity/v1/oauth2/revoke`;
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  environment: EbayEnvironment,
  clientId: string,
  clientSecret: string,
  body: Record<string, string>,
): Promise<EbayTokenSet> {
  const response = await fetchImpl(ebayTokenUrl(environment), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams(body).toString(),
  });
  const payload = await parseJsonOrNull(response);
  if (!response.ok) {
    mapEbayHttpError(response.status);
  }
  const record = asRecord(payload);
  const accessToken = asString(record.access_token);
  const refreshToken = asString(record.refresh_token);
  const expiresIn = asNumber(record.expires_in);
  if (!accessToken || !refreshToken || expiresIn == null) {
    throw providerResponseInvalid();
  }
  return {
    accessToken,
    refreshToken,
    tokenType: asString(record.token_type) ?? "User Access Token",
    expiresInSeconds: expiresIn,
    refreshTokenExpiresInSeconds: asNumber(record.refresh_token_expires_in),
    scope: asString(record.scope),
  };
}

async function ebayJson(
  fetchImpl: typeof fetch,
  input: { url: string; accessToken: string; marketplaceId?: string },
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${input.accessToken}`,
  };
  if (input.marketplaceId) {
    headers["X-EBAY-C-MARKETPLACE-ID"] = input.marketplaceId;
  }
  const response = await fetchImpl(input.url, { headers });
  const payload = await parseJsonOrNull(response);
  if (!response.ok) {
    mapEbayHttpError(response.status);
  }
  return payload;
}

async function parseJsonOrNull(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw providerResponseInvalid();
  }
}

export function parseOrderList(payload: unknown, limit: number, offset: number): EbayOrderList {
  const record = asRecord(payload);
  const rawOrders = Array.isArray(record.orders) ? record.orders : [];
  const orders = rawOrders
    .map((entry) => parseOrder(entry))
    .filter((order): order is EbayOrder => order != null);
  return {
    orders,
    total: asNumber(record.total),
    limit,
    offset,
  };
}

export function parseOrder(payload: unknown): EbayOrder | null {
  const record = asRecord(payload);
  const orderId = asString(record.orderId);
  if (!orderId) {
    return null;
  }
  const buyer = asRecord(record.buyer);
  const pricing = asRecord(record.pricingSummary);
  const cancel = asRecord(record.cancelStatus);
  const instructions = Array.isArray(record.fulfillmentStartInstructions)
    ? record.fulfillmentStartInstructions
    : [];
  const shipping = parseShipping(instructions);
  const lineItems = Array.isArray(record.lineItems)
    ? record.lineItems.map(parseLineItem).filter((item): item is EbayOrderLineItem => item != null)
    : [];
  return {
    orderId,
    legacyOrderId: asString(record.legacyOrderId),
    creationDate: asString(record.creationDate),
    lastModifiedDate: asString(record.lastModifiedDate),
    orderFulfillmentStatus: asString(record.orderFulfillmentStatus),
    orderPaymentStatus: asString(record.orderPaymentStatus),
    sellerId: asString(record.sellerId),
    cancelState: asString(cancel.cancelState),
    buyerUsername: asString(buyer.username),
    total: parseMoney(pricing.total) ?? parseMoney(record.total),
    lineItems,
    shippingCarrier: shipping.carrier,
    shippingService: shipping.service,
    trackingNumber: shipping.trackingNumber,
  };
}

function parseLineItem(value: unknown): EbayOrderLineItem | null {
  const record = asRecord(value);
  const title = asString(record.title);
  const lineItemId = asString(record.lineItemId);
  if (!title && !lineItemId) {
    return null;
  }
  return {
    lineItemId,
    legacyItemId: asString(record.legacyItemId) ?? asString(record.legacyVariationId),
    sku: asString(record.sku),
    title,
    quantity: asNumber(record.quantity),
    lineItemCost: parseMoney(record.lineItemCost) ?? parseMoney(record.total),
  };
}

function parseShipping(instructions: unknown[]): {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
} {
  for (const entry of instructions) {
    const record = asRecord(entry);
    const step = asRecord(record.shippingStep);
    const carrier = asString(step.shippingCarrierCode);
    const service = asString(step.shippingServiceCode);
    const tracking = asString(step.trackingNumber);
    if (carrier || service || tracking) {
      return { carrier, service, trackingNumber: tracking };
    }
  }
  return { carrier: null, service: null, trackingNumber: null };
}

function parseMoney(value: unknown): EbayMoney | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { value: String(value), currency: null };
  }
  const record = asRecord(value);
  const amount = asString(record.value) ?? asString(record.convertedFromValue);
  if (!amount) {
    return null;
  }
  return { value: amount, currency: asString(record.currency) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
