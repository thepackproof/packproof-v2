import type { EbayEnvironment } from "./constants.js";

export interface EbayTokenSet {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresInSeconds: number;
  refreshTokenExpiresInSeconds: number | null;
  scope: string | null;
}

export interface EbayUserIdentity {
  userId: string;
  username: string | null;
  accountType: string | null;
}

export interface EbayMoney {
  value: string | null;
  currency: string | null;
}

export interface EbayOrderLineItem {
  lineItemId: string | null;
  legacyItemId: string | null;
  sku: string | null;
  title: string | null;
  quantity: number | null;
  lineItemCost: EbayMoney | null;
}

export interface EbayOrder {
  orderId: string;
  legacyOrderId: string | null;
  creationDate: string | null;
  lastModifiedDate: string | null;
  orderFulfillmentStatus: string | null;
  orderPaymentStatus: string | null;
  sellerId: string | null;
  cancelState: string | null;
  buyerUsername: string | null;
  total: EbayMoney | null;
  lineItems: EbayOrderLineItem[];
  shippingCarrier: string | null;
  shippingService: string | null;
  trackingNumber: string | null;
}

export interface EbayOrderList {
  orders: EbayOrder[];
  total: number | null;
  limit: number;
  offset: number;
}

export interface EbayClient {
  exchangeAuthorizationCode(input: {
    environment: EbayEnvironment;
    clientId: string;
    clientSecret: string;
    ruName: string;
    code: string;
  }): Promise<EbayTokenSet>;
  refreshUserToken(input: {
    environment: EbayEnvironment;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<EbayTokenSet>;
  getUser(input: {
    environment: EbayEnvironment;
    accessToken: string;
  }): Promise<EbayUserIdentity>;
  listOrders(input: {
    environment: EbayEnvironment;
    accessToken: string;
    marketplaceId: string;
    limit?: number;
    offset?: number;
  }): Promise<EbayOrderList>;
  getOrder(input: {
    environment: EbayEnvironment;
    accessToken: string;
    marketplaceId: string;
    orderId: string;
  }): Promise<EbayOrder>;
  revokeUserToken?(input: {
    environment: EbayEnvironment;
    clientId: string;
    clientSecret: string;
    token: string;
  }): Promise<void>;
}
