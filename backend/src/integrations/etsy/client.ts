import { DomainError } from "../../domain/errors.js";
import { IntegrationError } from "../../domain/integration-errors.js";
import { ETSY_API_BASE, ETSY_MAX_OFFSET, ETSY_PAGE_SIZE } from "./constants.js";
import type { EtsyClient, EtsyMoney, EtsyReceipt, EtsyReceiptTransaction, EtsyTokenSet } from "./types.js";

const invalid = () => new IntegrationError("PROVIDER_RESPONSE_INVALID", "Etsy returned an incomplete or invalid response. No order was imported from that response.", 502, false);
const reauth = () => new IntegrationError("INTEGRATION_NEEDS_REAUTH", "Reconnect Etsy to restore authorized access to the shop.", 409, false);

export class EtsyRateLimitError extends IntegrationError {
  constructor(readonly retryAfterSeconds: number) {
    super("PROVIDER_RATE_LIMITED", "Etsy's request allowance is temporarily exhausted. PackProof will retry automatically.", 429, true);
  }
}

/** Shared by identity, token and order requests so an app-key budget is respected. */
export function createHttpEtsyClient(input: {
  clientId: string;
  getSharedSecret: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  minRequestIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  beforeRequest?: () => Promise<void>;
  afterResponse?: (response: Pick<Response, "status" | "headers">) => Promise<void>;
}): EtsyClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const interval = Math.max(0, input.minRequestIntervalMs ?? 250);
  const timeout = Math.min(30_000, Math.max(100, input.timeoutMs ?? 15_000));
  let nextRequestAt = 0;
  let pauseUntil = 0;
  let queue: Promise<unknown> = Promise.resolve();

  async function request(path: string, options: { token?: string; body?: URLSearchParams } = {}): Promise<unknown> {
    // Serialize the shared application key; a stalled request is bounded by timeout.
    const operation = queue.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (pauseUntil > now()) throw new EtsyRateLimitError(Math.ceil((pauseUntil - now()) / 1000));
        if (nextRequestAt > now()) await sleep(nextRequestAt - now());
        const secret = await input.getSharedSecret();
        if (!/^[A-Za-z0-9_-]{8,256}$/.test(secret) || !/^[A-Za-z0-9_-]{8,256}$/.test(input.clientId)) {
          throw new DomainError("ETSY_APPLICATION_NOT_CONFIGURED", "PackProof's Etsy application credentials need attention.", 503);
        }
        await input.beforeRequest?.();
        nextRequestAt = now() + interval;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        let response: Response;
        let payload: unknown;
        try {
          response = await fetchImpl(`${ETSY_API_BASE}${path}`, {
            method: options.body ? "POST" : "GET",
            redirect: "error",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "x-api-key": `${input.clientId}:${secret}`,
              ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
              ...(options.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
            },
            body: options.body?.toString(),
          });
          await input.afterResponse?.({ status: response.status, headers: response.headers });
          if (response.ok) payload = await boundedJson(response);
          else await response.body?.cancel();
        } catch (error) {
          if (error instanceof DomainError) throw error;
          throw new IntegrationError("PROVIDER_TEMPORARILY_UNAVAILABLE", "Etsy could not be reached. PackProof will retry automatically.", 503, true);
        } finally {
          clearTimeout(timer);
        }
        if (response!.ok) return payload;
        if (response!.status === 429) {
          const seconds = retryAfterSeconds(response!.headers.get("retry-after"), now());
          pauseUntil = now() + seconds * 1000;
          // Only retry reads, once, and only for a short explicit provider wait.
          if (!options.body && attempt === 0 && seconds <= 2) {
            await sleep(seconds * 1000);
            continue;
          }
          throw new EtsyRateLimitError(seconds);
        }
        if (response!.status === 401 || response!.status === 403 || (options.body && response!.status === 400)) throw reauth();
        if (response!.status === 404) throw new DomainError("ETSY_RESOURCE_NOT_FOUND", "The Etsy shop or receipt is unavailable to this connection.", 404);
        if (response!.status >= 500) throw new IntegrationError("PROVIDER_TEMPORARILY_UNAVAILABLE", "Etsy is temporarily unavailable. PackProof will retry automatically.", 503, true);
        throw invalid();
      }
      throw invalid();
    });
    queue = operation.catch(() => undefined);
    return operation;
  }

  return {
    async exchangeAuthorizationCode(value) {
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(value.codeVerifier) || !value.code.trim()) throw reauth();
      return parseToken(await request("/public/oauth/token", { body: new URLSearchParams({
        grant_type: "authorization_code", client_id: input.clientId, redirect_uri: value.redirectUri,
        code: value.code, code_verifier: value.codeVerifier,
      }) }));
    },
    async refreshUserToken(value) {
      const owner = etsyUserIdFromToken(value.refreshToken);
      const token = parseToken(await request("/public/oauth/token", { body: new URLSearchParams({
        grant_type: "refresh_token", client_id: input.clientId, refresh_token: value.refreshToken,
      }) }));
      if (etsyUserIdFromToken(token.accessToken) !== owner || etsyUserIdFromToken(token.refreshToken) !== owner) throw reauth();
      return token;
    },
    async getShop(value) {
      const userId = etsyUserIdFromToken(value.accessToken);
      let payload: unknown;
      try { payload = await request(`/application/users/${userId}/shops`, { token: value.accessToken }); }
      catch (error) {
        if (error instanceof DomainError && error.code === "ETSY_RESOURCE_NOT_FOUND") throw new DomainError("ETSY_SELLER_SHOP_REQUIRED", "This Etsy account does not have an available seller shop. Connect the account that owns the shop.", 409);
        throw error;
      }
      const shop = record(payload);
      if (etsyId(shop.user_id) !== userId) throw reauth();
      return { shopId: etsyId(shop.shop_id), userId, shopName: string(shop.shop_name, 200) ?? "Etsy shop" };
    },
    async listReceipts(value) {
      etsyUserIdFromToken(value.accessToken);
      const offset = value.offset ?? 0;
      const limit = value.limit ?? ETSY_PAGE_SIZE;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > ETSY_MAX_OFFSET || !Number.isSafeInteger(limit) || limit < 1 || limit > ETSY_PAGE_SIZE) {
        throw new DomainError("PROVIDER_CURSOR_INVALID", "Invalid Etsy receipt page cursor.", 400);
      }
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset), sort_on: "updated", sort_order: "asc" });
      if (value.minLastModified) params.set("min_last_modified", String(unixSeconds(value.minLastModified)));
      if (value.maxLastModified) params.set("max_last_modified", String(unixSeconds(value.maxLastModified)));
      if (typeof value.wasPaid === "boolean") params.set("was_paid", String(value.wasPaid));
      if (typeof value.wasShipped === "boolean") params.set("was_shipped", String(value.wasShipped));
      const payload = record(await request(`/application/shops/${etsyId(value.shopId)}/receipts?${params}`, { token: value.accessToken }));
      const receipts = array(payload.results, ETSY_PAGE_SIZE).map(parseEtsyReceipt);
      const total = integer(payload.count, 0);
      if (receipts.length > limit || new Set(receipts.map(receipt => receipt.receipt_id)).size !== receipts.length || total < receipts.length || (receipts.length === 0 && offset < total)) throw invalid();
      return { receipts, total, limit, offset };
    },
    async getReceipt(value) {
      etsyUserIdFromToken(value.accessToken);
      const receipt = parseEtsyReceipt(await request(`/application/shops/${etsyId(value.shopId)}/receipts/${etsyId(value.receiptId)}`, { token: value.accessToken }));
      if (receipt.receipt_id !== value.receiptId) throw invalid();
      return receipt;
    },
  };
}

export function etsyUserIdFromToken(value: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}\.[A-Za-z0-9_-]+$/.test(value) || value.length > 8192) throw reauth();
  return value.slice(0, value.indexOf("."));
}

function parseToken(payload: unknown): EtsyTokenSet {
  const value = record(payload);
  const accessToken = string(value.access_token, 8192);
  const refreshToken = string(value.refresh_token, 8192);
  if (!accessToken || !refreshToken || value.token_type !== "Bearer" || etsyUserIdFromToken(accessToken) !== etsyUserIdFromToken(refreshToken)) throw invalid();
  const expiresInSeconds = integer(value.expires_in, 1);
  if (expiresInSeconds > 86_400 || (value.scope != null && typeof value.scope !== "string")) throw invalid();
  return { accessToken, refreshToken, tokenType: "Bearer", expiresInSeconds,
    scopes: value.scope == null ? null : value.scope.split(/\s+/).filter(Boolean) };
}

export function parseEtsyReceipt(payload: unknown): EtsyReceipt {
  const value = record(payload);
  const receiptId = etsyId(value.receipt_id);
  const sellerId = etsyId(value.seller_user_id);
  const transactions = array(value.transactions, 500).map(item => parseTransaction(item, receiptId, sellerId));
  if (!transactions.length || new Set(transactions.map(item => item.transaction_id)).size !== transactions.length) throw invalid();
  return {
    receipt_id: receiptId, seller_user_id: sellerId,
    buyer_user_id: value.buyer_user_id == null || value.buyer_user_id === 0 ? null : etsyId(value.buyer_user_id),
    status: (string(value.status, 100) ?? "unknown").toLowerCase(),
    is_paid: bool(value.is_paid), is_shipped: bool(value.is_shipped),
    create_timestamp: timestamp(value.create_timestamp ?? value.created_timestamp)!,
    update_timestamp: timestamp(value.update_timestamp ?? value.updated_timestamp)!,
    grandtotal: parseMoney(value.grandtotal), transactions,
    shipments: array(value.shipments, 100).map(item => {
      const shipment = record(item);
      return { receipt_shipping_id: shipment.receipt_shipping_id == null ? null : etsyId(shipment.receipt_shipping_id),
        shipment_notification_timestamp: timestamp(shipment.shipment_notification_timestamp, true),
        carrier_name: string(shipment.carrier_name, 100), tracking_code: string(shipment.tracking_code, 100) };
    }),
    refundCount: array(value.refunds, 500).length,
  };
}

function parseTransaction(payload: unknown, receiptId: string, sellerId: string): EtsyReceiptTransaction {
  const value = record(payload);
  if (etsyId(value.receipt_id) !== receiptId || etsyId(value.seller_user_id) !== sellerId) throw invalid();
  return { transaction_id: etsyId(value.transaction_id), receipt_id: receiptId, seller_user_id: sellerId,
    title: string(value.title, 500), sku: string(value.sku, 200), quantity: integer(value.quantity, 0),
    is_digital: bool(value.is_digital), shipped_timestamp: timestamp(value.shipped_timestamp, true),
    price: parseMoney(value.price),
    variations: value.variations == null ? [] : array(value.variations, 20).map(item => {
      const variation = record(item);
      return { formatted_name: string(variation.formatted_name, 200) ?? "Option", formatted_value: string(variation.formatted_value, 200) ?? "" };
    }),
  };
}

function parseMoney(payload: unknown): EtsyMoney | null {
  if (payload == null) return null;
  const value = record(payload);
  const amount = integer(value.amount, 0);
  const divisor = integer(value.divisor, 1);
  const currency = string(value.currency_code, 3);
  if (!currency || !/^[A-Z]{3}$/.test(currency) || ![1,10,100,1000,10000,100000,1000000].includes(divisor)) throw invalid();
  return { amount, divisor, currency_code: currency };
}

export function etsyId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) throw invalid();
    return String(value);
  }
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) throw invalid();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > max) throw invalid();
  return value.trim() || null;
}
function integer(value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw invalid();
  return value;
}
function timestamp(value: unknown, nullable = false): number | null {
  if (nullable && (value == null || value === 0)) return null;
  const seconds = integer(value, 946684800);
  if (seconds > 253402300799) throw invalid();
  return seconds;
}
function bool(value: unknown): boolean | null { return typeof value === "boolean" ? value : null; }
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
}
function unixSeconds(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 946684800000) throw new DomainError("PROVIDER_CURSOR_INVALID", "Invalid Etsy synchronization time window.", 400);
  return Math.floor(ms / 1000);
}
function retryAfterSeconds(value: string | null, now: number): number {
  if (value && /^\d+$/.test(value)) return Math.max(1, Math.min(86_400, Number(value)));
  if (value && Number.isFinite(Date.parse(value))) return Math.max(1, Math.min(86_400, Math.ceil((Date.parse(value) - now) / 1000)));
  return 60;
}
async function boundedJson(response: Response): Promise<unknown> {
  const maximum = 8 * 1024 * 1024;
  if (Number(response.headers.get("content-length") ?? 0) > maximum) { await response.body?.cancel(); throw invalid(); }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > maximum) { await reader.cancel(); throw invalid(); }
    chunks.push(part.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw invalid(); }
}
