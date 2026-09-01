import type { EbayClient, EbayOrder, EbayTokenSet, EbayUserIdentity } from "../../src/integrations/ebay/types.js";
import { providerAuthFailed, providerResponseInvalid } from "../../src/domain/integration-errors.js";

export const EBAY_FIXTURE_ORDER_ID = "12-00007-84931";
export const EBAY_FIXTURE_ORDER_ID_SHIPPED = "12-00007-84932";

export function fixtureEbayOrders(): EbayOrder[] {
  return [
    {
      orderId: EBAY_FIXTURE_ORDER_ID,
      legacyOrderId: "26-09876-54321",
      creationDate: "2026-08-31T18:12:00.000Z",
      lastModifiedDate: "2026-08-31T18:12:00.000Z",
      orderFulfillmentStatus: "NOT_STARTED",
      orderPaymentStatus: "PAID",
      sellerId: "collin_seller",
      cancelState: "NONE_REQUESTED",
      buyerUsername: "filmshooter",
      total: { value: "349.99", currency: "USD" },
      lineItems: [
        {
          lineItemId: "10032456789012",
          legacyItemId: "387654321098",
          sku: "NIKON-F3",
          title: "Nikon F3 Camera",
          quantity: 1,
          lineItemCost: { value: "349.99", currency: "USD" },
        },
      ],
      shippingCarrier: null,
      shippingService: null,
      trackingNumber: null,
    },
    {
      orderId: EBAY_FIXTURE_ORDER_ID_SHIPPED,
      legacyOrderId: "26-09876-54322",
      creationDate: "2026-08-30T16:00:00.000Z",
      lastModifiedDate: "2026-08-30T20:00:00.000Z",
      orderFulfillmentStatus: "FULFILLED",
      orderPaymentStatus: "PAID",
      sellerId: "collin_seller",
      cancelState: "NONE_REQUESTED",
      buyerUsername: "cardshop",
      total: { value: "725.00", currency: "USD" },
      lineItems: [
        {
          lineItemId: "10032456789099",
          legacyItemId: "387654321077",
          sku: "PKMN-BB",
          title: "Pokémon Booster Box",
          quantity: 1,
          lineItemCost: { value: "725.00", currency: "USD" },
        },
      ],
      shippingCarrier: "USPS",
      shippingService: "Priority",
      trackingNumber: null,
    },
  ];
}

export class FakeEbayClient implements EbayClient {
  codes = new Map<string, EbayUserIdentity>();
  refreshTokens = new Map<string, EbayUserIdentity>();
  orders = fixtureEbayOrders();
  refreshFail = false;
  tokenSeq = 0;

  constructor() {
    this.codes.set("valid-ebay-code", {
      userId: "ebay-user-001",
      username: "collin_seller",
      accountType: "INDIVIDUAL",
    });
  }

  async exchangeAuthorizationCode(input: {
    environment: "sandbox" | "production";
    clientId: string;
    clientSecret: string;
    ruName: string;
    code: string;
  }): Promise<EbayTokenSet> {
    if (input.clientSecret !== "test-cert-id") {
      throw providerAuthFailed();
    }
    const user = this.codes.get(input.code);
    if (!user) {
      throw providerAuthFailed();
    }
    return this.issueTokens(user);
  }

  async refreshUserToken(input: {
    environment: "sandbox" | "production";
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<EbayTokenSet> {
    if (this.refreshFail) {
      throw providerAuthFailed();
    }
    if (input.clientSecret !== "test-cert-id") {
      throw providerAuthFailed();
    }
    const user = this.refreshTokens.get(input.refreshToken);
    if (!user) {
      throw providerAuthFailed();
    }
    return this.issueTokens(user);
  }

  async getUser(input: {
    environment: "sandbox" | "production";
    accessToken: string;
  }): Promise<EbayUserIdentity> {
    const user = this.userFromAccess(input.accessToken);
    if (!user) {
      throw providerAuthFailed();
    }
    return user;
  }

  async listOrders(input: {
    environment: "sandbox" | "production";
    accessToken: string;
    marketplaceId: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    orders: EbayOrder[];
    total: number;
    limit: number;
    offset: number;
  }> {
    if (!this.userFromAccess(input.accessToken)) {
      throw providerAuthFailed();
    }
    return { orders: this.orders, total: this.orders.length, limit: input.limit ?? 50, offset: input.offset ?? 0 };
  }

  async getOrder(input: {
    environment: "sandbox" | "production";
    accessToken: string;
    marketplaceId: string;
    orderId: string;
  }): Promise<EbayOrder> {
    if (!this.userFromAccess(input.accessToken)) {
      throw providerAuthFailed();
    }
    const order = this.orders.find((entry) => entry.orderId === input.orderId);
    if (!order) {
      throw providerResponseInvalid();
    }
    return order;
  }

  private issueTokens(user: EbayUserIdentity): EbayTokenSet {
    this.tokenSeq += 1;
    const refreshToken = `refresh-${this.tokenSeq}`;
    this.refreshTokens.set(refreshToken, user);
    return {
      accessToken: `access-${this.tokenSeq}:${user.userId}`,
      refreshToken,
      tokenType: "User Access Token",
      expiresInSeconds: 7200,
      refreshTokenExpiresInSeconds: 18 * 30 * 24 * 3600,
      scope: "sell.fulfillment.readonly",
    };
  }

  private userFromAccess(accessToken: string): EbayUserIdentity | null {
    const match = /^access-\d+:(.+)$/.exec(accessToken);
    if (!match?.[1]) {
      return null;
    }
    return { userId: match[1], username: "collin_seller", accountType: "INDIVIDUAL" };
  }
}
