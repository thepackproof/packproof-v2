export const SHOPIFY_ADAPTER_KEY = "shopify";
export const SHOPIFY_PROVIDER = "shopify";
export const SHOPIFY_API_VERSION = "2024-10";

export const SHOPIFY_SCOPES = ["read_orders", "read_fulfillments"] as const;

export const SHOPIFY_CAPABILITIES = {
  identity: true,
  transactions: true,
  fulfillment: true,
  shipping: false,
  webhooks: true,
} as const;

export const SHOPIFY_LIMITATIONS = [
  "PackProof connects a Shopify shop through official OAuth install and reads orders/fulfillments the Admin API returns.",
  "One PackProof user may connect multiple shops.",
  "Shopify Marketplace / Shop App buyer surfaces are not implemented.",
  "Carrier-grade shipping APIs are not included in this connection.",
];

export function shopifyAdminApiUrl(shop: string, path: string): string {
  return `https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

export function shopifyAuthorizeUrl(shop: string): string {
  return `https://${shop}/admin/oauth/authorize`;
}

export function shopifyTokenUrl(shop: string): string {
  return `https://${shop}/admin/oauth/access_token`;
}

export function shopifyRevokeUrl(shop: string): string {
  return shopifyAdminApiUrl(shop, "/api_permissions/current.json");
}
