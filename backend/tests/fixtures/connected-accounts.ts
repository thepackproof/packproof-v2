import type { FetchLike } from "../../src/integrations/connected-accounts/http.js";
import type { ShopifyClient, ShopifyOrder, ShopifyOrderPage, ShopifyShopIdentity, ShopifyTokenSet } from "../../src/integrations/shopify/types.js";
import { providerAuthFailed, providerResponseInvalid } from "../../src/domain/integration-errors.js";

export class FakeShopifyClient implements ShopifyClient {
  codes = new Map<string, { shop: string; name: string }>();
  tokens = new Map<string, { shop: string; name: string }>();
  orders: ShopifyOrder[] = [];
  revoked = 0;
  tokenSeq = 0;

  constructor() {
    this.codes.set("valid-shopify-code", { shop: "packproof-test.myshopify.com", name: "PackProof Test Shop" });
    this.orders = [
      {
        id: "gid-1001",
        name: "#1001",
        createdAt: "2026-08-20T15:00:00.000Z",
        cancelledAt: null,
        financialStatus: "paid",
        fulfillmentStatus: null,
        totalPrice: "42.00",
        currency: "USD",
        customer: { id: "cust-1", displayName: "Jordan Buyer" },
        lineItems: [
          {
            id: "li-1",
            title: "Test Card",
            sku: "CARD-1",
            quantity: 1,
            price: "42.00",
            requiresShipping: true,
          },
        ],
        trackingCompany: null,
        trackingNumber: null,
      },
    ];
  }

  async exchangeAuthorizationCode(input: {
    shop: string;
    clientId: string;
    clientSecret: string;
    code: string;
  }): Promise<ShopifyTokenSet> {
    if (input.clientSecret !== "shopify-secret") {
      throw providerAuthFailed();
    }
    const found = this.codes.get(input.code);
    if (!found || found.shop !== input.shop) {
      throw providerAuthFailed();
    }
    this.tokenSeq += 1;
    const accessToken = `shp-access-${this.tokenSeq}`;
    this.tokens.set(accessToken, found);
    return { accessToken, scope: "read_orders,read_fulfillments" };
  }

  async getShop(input: { shop: string; accessToken: string }): Promise<ShopifyShopIdentity> {
    const found = this.tokens.get(input.accessToken);
    if (!found) {
      throw providerAuthFailed();
    }
    return {
      shopId: "shop-123",
      name: found.name,
      myshopifyDomain: found.shop,
      email: "owner@example.com",
    };
  }

  async listOrders(input: { shop: string; accessToken: string }): Promise<ShopifyOrderPage> {
    if (!this.tokens.get(input.accessToken)) {
      throw providerAuthFailed();
    }
    return { orders: this.orders, cursor: null };
  }

  async revoke(): Promise<void> {
    this.revoked += 1;
  }
}

export function createScriptedFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as FetchLike;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function googleScriptedFetch(options: { refreshFail?: boolean } = {}): FetchLike {
  let tokenSeq = 0;
  const refreshOk = !options.refreshFail;
  return createScriptedFetch(async (url, init) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = String(init?.body ?? "");
      if (body.includes("grant_type=refresh_token") && !refreshOk) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      if (body.includes("grant_type=refresh_token") && !body.includes("refresh_token=google-refresh")) {
        if (!body.includes("refresh_token=google-refresh-")) {
          return jsonResponse({ error: "invalid_grant" }, 400);
        }
      }
      if (body.includes("grant_type=authorization_code") && !body.includes("code=valid-google-code")) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      if (body.includes("client_secret=leaked-should-not-appear")) {
        return jsonResponse({ error: "no" }, 400);
      }
      tokenSeq += 1;
      return jsonResponse({
        access_token: `google-access-${tokenSeq}`,
        refresh_token: body.includes("grant_type=refresh_token") ? undefined : `google-refresh-${tokenSeq}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
      });
    }
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      if (!auth.startsWith("Bearer google-access-")) {
        return jsonResponse({ error: "unauth" }, 401);
      }
      return jsonResponse({
        sub: "google-sub-001",
        name: "Collin Google",
        email: "collin@gmail.com",
        email_verified: true,
      });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected google url ${url}`);
  });
}

export function facebookScriptedFetch(): FetchLike {
  let tokenSeq = 0;
  return createScriptedFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/oauth/access_token")) {
      if (parsed.searchParams.get("code") && parsed.searchParams.get("code") !== "valid-facebook-code") {
        return jsonResponse({ error: { message: "bad code" } }, 400);
      }
      if (parsed.searchParams.get("client_secret") !== "facebook-secret") {
        return jsonResponse({ error: { message: "bad secret" } }, 400);
      }
      tokenSeq += 1;
      return jsonResponse({
        access_token: `facebook-access-${tokenSeq}`,
        token_type: "bearer",
        expires_in: 5184000,
      });
    }
    if (parsed.pathname.endsWith("/me")) {
      const token = parsed.searchParams.get("access_token") ?? "";
      if (!token.startsWith("facebook-access-")) {
        return jsonResponse({ error: { message: "unauth" } }, 401);
      }
      return jsonResponse({ id: "fb-user-001", name: "Collin Meta" });
    }
    if (parsed.pathname.endsWith("/me/permissions")) {
      return jsonResponse({ success: true });
    }
    throw new Error(`unexpected facebook url ${url}`);
  });
}

export function expectNoSecretLeak(value: unknown, secrets: string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (serialized.includes(secret)) {
      throw new Error(`secret leaked: ${secret}`);
    }
  }
}
