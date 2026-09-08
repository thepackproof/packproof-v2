import { describe, expect, it, vi } from "vitest";
import { createHttpEtsyClient, etsyUserIdFromToken, parseEtsyReceipt } from "../src/integrations/etsy/client.js";
import { normalizeEtsyReceipt } from "../src/integrations/etsy/normalize.js";
import { eligibilityOf, parseNormalizedFulfillmentOrder } from "../src/domain/normalized-fulfillment-order.js";
import { createEtsyConnectedAccountProvider } from "../src/integrations/connected-accounts/providers/etsy.js";
import { createEtsyRuntime } from "../src/integrations/etsy/runtime.js";
import { pkceChallengeS256 } from "../src/integrations/connected-accounts/pkce.js";

const accessToken = "1234.synthetic-access-token";
const refreshToken = "1234.synthetic-refresh-token";
const clientId = "synthetic-keystring";
const sharedSecret = "synthetic-shared-secret";
const redirectUri = "https://example.test/api/oauth/etsy/callback";
const verifier = "a".repeat(43);
const money = (amount = 1999, divisor = 100) => ({ amount, divisor, currency_code: "USD" });
const transaction = (id = 9001) => ({ transaction_id: id, receipt_id: 8001, seller_user_id: 1234, title: "Vintage VHS", sku: "VHS-01", quantity: 2, is_digital: false, shipped_timestamp: null, price: money(), variations: [{ formatted_name: "Edition", formatted_value: "Original" }] });
const rawReceipt = () => ({ receipt_id: 8001, seller_user_id: 1234, buyer_user_id: 5555, status: "paid", is_paid: true, is_shipped: false, create_timestamp: 1788739200, update_timestamp: 1788739300, grandtotal: money(4500), transactions: [transaction()], shipments: [], refunds: [], first_line: "Private address never imported", buyer_email: "buyer@example.invalid" });
const tokenPayload = () => ({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope: "shops_r transactions_r" });
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), { status: 200, ...init, headers: { "Content-Type": "application/json", ...init?.headers } });

function http(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected synthetic request");
    return response;
  }) as unknown as typeof fetch;
  return { client: createHttpEtsyClient({ clientId, getSharedSecret: async () => sharedSecret, fetchImpl, minRequestIntervalMs: 0 }), calls, fetchImpl };
}

function provider(responses: Response[]) {
  const setup = http(responses);
  const credentials = { getCredentials: async () => ({ adapterKey: "etsy", credentialReference: "test:etsy", material: { sharedSecret } }) };
  const runtime = { enabled: true, clientId, appCredentialReference: "test:etsy", redirectUri, client: setup.client };
  return { ...setup, provider: createEtsyConnectedAccountProvider({ runtime, credentials }) };
}

describe("Etsy OAuth read-only seller connection", () => {
  it("uses exact HTTPS callback, random state and S256 without leaking the shared secret", async () => {
    const { provider: api } = provider([]);
    const { authorizationUrl } = await api.getAuthorizationUrl({ state: "synthetic-state", codeVerifier: verifier, redirectUri });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://www.etsy.com/oauth/connect");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: clientId, scope: "shops_r transactions_r", redirect_uri: redirectUri, state: "synthetic-state", code_challenge_method: "S256", code_challenge: pkceChallengeS256(verifier) });
    expect(authorizationUrl).not.toContain(sharedSecret);
    expect(authorizationUrl).not.toContain(verifier);
  });

  it("exchanges with a form and resolves the owner shop from authenticated token identity", async () => {
    const { provider: api, calls } = provider([json(tokenPayload()), json({ shop_id: 7001, user_id: 1234, shop_name: "SyntheticVHS" })]);
    const result = await api.handleCallback({ code: "synthetic-code", codeVerifier: verifier, redirectUri, extra: { shopId: "9999" } });
    expect(result.identity).toMatchObject({ externalAccountId: "7001", externalAccountName: "SyntheticVHS" });
    expect(result.tokens.extraMaterial).toEqual({ etsyShopId: "7001", etsyUserId: "1234", etsyShopName: "SyntheticVHS" });
    expect(calls[1].url).toContain("/users/1234/shops");
    expect(calls[0].init.redirect).toBe("error");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toMatchObject({ client_id: clientId, code_verifier: verifier, redirect_uri: redirectUri });
    expect(String(calls[0].init.body)).not.toContain(sharedSecret);
    for (const call of calls) expect(new Headers(call.init.headers).get("x-api-key")).toBe(`${clientId}:${sharedSecret}`);
    expect(new Headers(calls[1].init.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
  });

  it("rejects mismatched callback, missing verifier and missing read scope before connecting", async () => {
    const { provider: api, calls } = provider([json({ ...tokenPayload(), scope: "shops_r" })]);
    await expect(api.handleCallback({ code: "code", codeVerifier: verifier, redirectUri: `${redirectUri}/` })).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
    await expect(api.handleCallback({ code: "code", codeVerifier: null, redirectUri })).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
    expect(calls).toHaveLength(0);
    await expect(api.handleCallback({ code: "code", codeVerifier: verifier, redirectUri })).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect(calls).toHaveLength(1);
  });

  it("refuses another seller's returned shop or a buyer account without a shop", async () => {
    const { client } = http([json({ shop_id: 7001, user_id: 9999, shop_name: "Wrong" }), json({}, { status: 404 })]);
    await expect(client.getShop({ accessToken })).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    await expect(client.getShop({ accessToken })).rejects.toMatchObject({ code: "ETSY_SELLER_SHOP_REQUIRED" });
  });

  it("keeps rotated refresh tokens and original shop identity, rejects changed owner", async () => {
    const { provider: api } = provider([json({ ...tokenPayload(), access_token: "1234.rotated-access", refresh_token: "1234.rotated-refresh" }), json({ ...tokenPayload(), access_token: "9999.wrong", refresh_token: "9999.wrong-refresh" })]);
    const material = { accessToken, refreshToken, etsyShopId: "7001", etsyUserId: "1234", etsyShopName: "SyntheticVHS", scope: "shops_r transactions_r" };
    const tokens = await api.refreshCredentials({ material });
    expect(tokens.refreshToken).toBe("1234.rotated-refresh");
    expect(tokens.extraMaterial?.etsyShopId).toBe("7001");
    await expect(api.refreshCredentials({ material })).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
  });

  it("checks configuration before sending a seller to Etsy", async () => {
    const credentials = { getCredentials: async () => null };
    const runtime = createEtsyRuntime({ enabled: true, clientId, appCredentialReference: "test:etsy", redirectUri, credentials });
    const api = createEtsyConnectedAccountProvider({ runtime, credentials });
    await expect(api.getAuthorizationUrl({ state: "state", codeVerifier: verifier, redirectUri })).rejects.toMatchObject({ code: "ETSY_APPLICATION_NOT_CONFIGURED" });
    expect(() => etsyUserIdFromToken("secret-without-owner-prefix")).toThrow();
  });
});

describe("Etsy receipt transport and API budget", () => {
  it("uses bounded, stable updated pagination without hiding shipped/cancelled changes", async () => {
    const { client, calls } = http([json({ count: 101, results: [rawReceipt()] })]);
    const page = await client.listReceipts({ accessToken, shopId: "7001", minLastModified: "2026-09-01T00:00:00Z", maxLastModified: "2026-09-07T00:00:00Z", offset: 100 });
    expect(page).toMatchObject({ total: 101, offset: 100, limit: 100 });
    const params = new URL(calls[0].url).searchParams;
    expect(params.get("sort_on")).toBe("updated");
    expect(params.get("sort_order")).toBe("asc");
    expect(params.get("was_paid")).toBeNull();
    expect(params.get("was_shipped")).toBeNull();
    expect(params.get("min_last_modified")).toBe("1788220800");
    expect(JSON.stringify(page)).not.toMatch(/Private address|buyer@example/);
  });

  it("rejects corrupted pagination and bounds receipt IDs before issuing a request", async () => {
    const { client, calls } = http([json({ count: 10, results: [] }), json({ count: 2, results: [rawReceipt(), rawReceipt()] })]);
    await expect(client.listReceipts({ accessToken, shopId: "7001", offset: 100001 })).rejects.toMatchObject({ code: "PROVIDER_CURSOR_INVALID" });
    await expect(client.getReceipt({ accessToken, shopId: "7001", receiptId: "1/../../token" })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(calls).toHaveLength(0);
    await expect(client.listReceipts({ accessToken, shopId: "7001" })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    await expect(client.listReceipts({ accessToken, shopId: "7001" })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("retains a long Retry-After without making another request or leaking provider errors", async () => {
    const { client, calls } = http([json({ error: "sensitive-provider-body" }, { status: 429, headers: { "retry-after": "3600" } })]);
    await expect(client.getShop({ accessToken })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterSeconds: 3600 });
    await expect(client.getShop({ accessToken })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    expect(calls).toHaveLength(1);
  });

  it("calls the shared distributed request budget on OAuth and reads", async () => {
    const beforeRequest = vi.fn(async () => {});
    const afterResponse = vi.fn(async () => {});
    const setup = http([json(tokenPayload()), json({ shop_id: 7001, user_id: 1234, shop_name: "Shop" })]);
    const client = createHttpEtsyClient({ clientId, getSharedSecret: async () => sharedSecret, fetchImpl: setup.fetchImpl, minRequestIntervalMs: 0, beforeRequest, afterResponse });
    await client.exchangeAuthorizationCode({ code: "code", codeVerifier: verifier, redirectUri });
    await client.getShop({ accessToken });
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(afterResponse).toHaveBeenCalledTimes(2);
    expect(afterResponse.mock.calls[0][0]).not.toHaveProperty("body");
  });

  it("aborts a stalled provider request within its timeout", async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted with synthetic private details"))))) as typeof fetch;
    const client = createHttpEtsyClient({ clientId, getSharedSecret: async () => sharedSecret, fetchImpl, timeoutMs: 100 });
    await expect(client.getShop({ accessToken })).rejects.toMatchObject({ code: "PROVIDER_TEMPORARILY_UNAVAILABLE", retryable: true });
  });
});

describe("Etsy fulfillment normalization", () => {
  const normalize = (raw: unknown) => parseNormalizedFulfillmentOrder(normalizeEtsyReceipt(parseEtsyReceipt(raw), { shopId: "7001", shopUserId: "1234" }));

  it("imports every line and exact quantities, interpreting amount/divisor as per-unit value", () => {
    const order = normalize({ ...rawReceipt(), transactions: [transaction(), { ...transaction(9002), quantity: 3, title: "Tape case", price: money(350) }] });
    expect(eligibilityOf(order)).toBe("FULFILLMENT_ELIGIBLE");
    expect(order).toMatchObject({ externalAccountReference: "7001", identityAccountReference: "7001", externalOrderId: "8001", transactionValue: 45, currency: "USD", provenance: { source: "MARKETPLACE_API", sourceRecordId: "8001" } });
    expect(order.items.map(item => [item.quantity, item.unitValue])).toEqual([[2, 19.99], [3, 3.5]]);
    expect(order.items[0].variant).toBe("Edition: Original");
    expect(normalize({ ...rawReceipt(), grandtotal: money(12345, 1000) }).transactionValue).toBe(12.345);
  });

  it.each([
    ["unpaid", { is_paid: false, status: "open" }, null],
    ["cancelled", { status: "canceled" }, "etsy_cancelled_order"],
    ["refund", { refunds: [{}] }, "etsy_refunded_order"],
    ["refunded status", { status: "partially refunded" }, "etsy_refunded_order"],
    ["shipped", { is_shipped: true }, null],
    ["completed status", { status: "completed" }, null],
    ["missing paid flag", { is_paid: null }, "etsy_incomplete_fulfillment_details"],
    ["unknown status", { status: "new status" }, "etsy_unconfirmed_order_status"],
  ])("holds %s out of the eligible queue", (_label, overrides, reason) => {
    const order = normalize({ ...rawReceipt(), ...overrides });
    expect(eligibilityOf(order)).not.toBe("FULFILLMENT_ELIGIBLE");
    expect(order.pilotCaptureExclusion ?? null).toBe(reason);
  });

  it("holds digital, mixed, partial, multiple and uncertain fulfillment for their specific reason", () => {
    const reason = (overrides: Record<string, unknown>) => normalize({ ...rawReceipt(), ...overrides }).pilotCaptureExclusion;
    expect(reason({ transactions: [{ ...transaction(), is_digital: true }] })).toBe("etsy_digital_order");
    expect(reason({ transactions: [transaction(), { ...transaction(9002), is_digital: true }] })).toBe("etsy_mixed_physical_and_digital_order");
    expect(reason({ transactions: [transaction(), { ...transaction(9002), shipped_timestamp: 1788739250 }] })).toBe("etsy_partial_shipment");
    expect(reason({ shipments: [{}, {}] })).toBe("etsy_multiple_shipments");
    expect(reason({ transactions: [{ ...transaction(), is_digital: undefined }] })).toBe("etsy_unknown_fulfillment");
  });

  it("rejects incomplete lines and unsafe numeric identities or money without partial imports", () => {
    expect(() => normalize({ ...rawReceipt(), transactions: [transaction(), {}] })).toThrow();
    expect(() => normalize({ ...rawReceipt(), seller_user_id: 9999 })).toThrow();
    expect(() => normalize({ ...rawReceipt(), receipt_id: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => normalize({ ...rawReceipt(), transactions: [transaction(), transaction()] })).toThrow();
    expect(() => normalize({ ...rawReceipt(), grandtotal: money(Number.MAX_SAFE_INTEGER + 1) })).toThrow();
    expect(() => normalize({ ...rawReceipt(), grandtotal: money(1234, 0) })).toThrow();
    expect(() => normalize({ ...rawReceipt(), transactions: undefined })).toThrow();
    expect(() => normalize({ ...rawReceipt(), refunds: undefined })).toThrow();
  });
});
