export interface ShopifyTokenSet {
  accessToken: string;
  scope: string;
}

export interface ShopifyShopIdentity {
  shopId: string;
  name: string | null;
  myshopifyDomain: string;
  email: string | null;
}

export interface ShopifyOrder {
  id: string;
  name: string | null;
  createdAt: string | null;
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  totalPrice: string | null;
  currency: string | null;
  customer: {
    id: string | null;
    displayName: string | null;
  } | null;
  lineItems: Array<{
    id: string | null;
    title: string | null;
    sku: string | null;
    quantity: number | null;
    price: string | null;
    requiresShipping: boolean | null;
  }>;
  trackingCompany: string | null;
  trackingNumber: string | null;
}

export interface ShopifyClient {
  exchangeAuthorizationCode(input: {
    shop: string;
    clientId: string;
    clientSecret: string;
    code: string;
  }): Promise<ShopifyTokenSet>;
  getShop(input: { shop: string; accessToken: string }): Promise<ShopifyShopIdentity>;
  listOrders(input: { shop: string; accessToken: string; limit?: number; cursor?: string | null }): Promise<ShopifyOrderPage>;
  revoke(input: { shop: string; accessToken: string }): Promise<void>;
}

export interface ShopifyOrderPage {
  orders: ShopifyOrder[];
  cursor: string | null;
}
